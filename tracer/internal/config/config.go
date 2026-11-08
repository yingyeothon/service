// Package config reads tracer's process configuration from `TRACER_*`
// environment variables (secrets also as `NAME_FILE`), like the gateway.
//
// Two modes, decided here and nowhere else:
//
//   - server: `TRACER_CONSOLE_URL` is set. Resources and read authorization
//     come from the console `/tr/*` routes behind `TRACER_TOKEN`; the local
//     resource file and the dump directory are refused.
//   - local: no console URL. Resources and one static read token come from
//     `TRACER_LOCAL_CONFIG` (`tracer.json`).
//
// Both modes listen on a loopback IP only (never a wildcard).
package config

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Mode is how the process learns resources and authorizes reads.
type Mode int

const (
	// ModeServer reads resources from the console (`TRACER_CONSOLE_URL`).
	ModeServer Mode = iota
	// ModeLocal reads resources from `tracer.json`; loopback only.
	ModeLocal
)

func (m Mode) String() string {
	if m == ModeLocal {
		return "local"
	}
	return "server"
}

const (
	// MinTokenLen mirrors the console's `MIN_TOKEN_LEN` (the gateway-token rule).
	MinTokenLen = 32
	// DefaultMaxEnvelopeBytes caps one envelope after decompression (docs/tracer.md _Ingest_).
	DefaultMaxEnvelopeBytes = 20 << 20
	// DefaultDiskMaxPct is the root volume usage at which ingest refuses (the host's investigation line).
	DefaultDiskMaxPct = 70
	// DefaultListen is the loopback port used in local mode and behind Caddy.
	DefaultListen = "127.0.0.1:8095"
)

// DefaultStageBytes is the write cap (DB + WAL + blobs) per stage
// (decisions _Debug collector_ #3). Unknown stages use the dev value.
var DefaultStageBytes = map[string]int64{
	"dev":  512 << 20,
	"prod": 1536 << 20,
}

// ResourceIDPattern is the console's id shape for tracer resources:
// `trc_` + a lowercase ULID (the `kv_` precedent), kept a little looser.
var ResourceIDPattern = regexp.MustCompile(`^trc_[0-9a-z]{1,40}$`)

// ReadTokenPattern is the console API token shape (`yyt_` + 48 hex).
var ReadTokenPattern = regexp.MustCompile(`^yyt_[0-9a-f]{48}$`)

// Config is the process-level configuration.
type Config struct {
	Mode Mode
	// Stage is `dev`/`prod` in server mode (anything else is refused), `local` in local mode.
	Stage string
	// ConsoleURL is the console API base URL (no trailing slash); server mode only.
	ConsoleURL string
	// Token is the shared `tracer-token`; server mode only. Never logged.
	Token string
	// Listen is the TCP address, a loopback IP literal.
	Listen string
	// DataDir holds `tracer.db` and `blobs/`.
	DataDir string
	// StageBytes caps DB + WAL + blobs.
	StageBytes int64
	// DiskMaxPct is the root volume usage line (percent) that refuses ingest.
	DiskMaxPct int
	// MaxEnvelopeBytes caps one envelope after decompression.
	MaxEnvelopeBytes int64
	// LogLevel is debug|info|warn|error.
	LogLevel string
	// DumpDir (local mode only) receives each raw request for fixture capture.
	DumpDir string
	// Local is the parsed `tracer.json` (local mode only).
	Local *LocalFile
}

// DBPath is the SQLite file inside DataDir.
func (c Config) DBPath() string { return strings.TrimRight(c.DataDir, "/") + "/tracer.db" }

// BlobDir is the blob root inside DataDir.
func (c Config) BlobDir() string { return strings.TrimRight(c.DataDir, "/") + "/blobs" }

// FromEnv builds a Config from `TRACER_*` variables.
func FromEnv(getenv func(string) string) (Config, error) {
	c := Config{
		Stage:            getenv("TRACER_STAGE"),
		ConsoleURL:       strings.TrimRight(getenv("TRACER_CONSOLE_URL"), "/"),
		Listen:           def(getenv("TRACER_LISTEN"), DefaultListen),
		DataDir:          getenv("TRACER_DATA_DIR"),
		DiskMaxPct:       DefaultDiskMaxPct,
		MaxEnvelopeBytes: DefaultMaxEnvelopeBytes,
		LogLevel:         def(getenv("TRACER_LOG_LEVEL"), "info"),
		DumpDir:          getenv("TRACER_DUMP_DIR"),
	}
	if c.ConsoleURL == "" {
		c.Mode = ModeLocal
	}
	var err error
	if c.Token, err = secret(getenv, "TRACER_TOKEN"); err != nil {
		return c, err
	}
	if v := getenv("TRACER_STAGE_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return c, errors.New("TRACER_STAGE_BYTES: not a positive integer")
		}
		c.StageBytes = n
	}
	if v := getenv("TRACER_DISK_MAX_PCT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 99 {
			return c, errors.New("TRACER_DISK_MAX_PCT: not an integer in 1..99")
		}
		c.DiskMaxPct = n
	}
	localPath := getenv("TRACER_LOCAL_CONFIG")
	if c.Mode == ModeLocal {
		if c.Stage == "" {
			c.Stage = "local"
		}
		if c.DataDir == "" {
			c.DataDir = "tracer-data"
		}
		if localPath == "" {
			localPath = "tracer.json"
		}
	}
	if c.StageBytes == 0 {
		if v, ok := DefaultStageBytes[c.Stage]; ok {
			c.StageBytes = v
		} else {
			c.StageBytes = DefaultStageBytes["dev"]
		}
	}
	if err := c.validate(localPath); err != nil {
		return c, err
	}
	if c.Mode == ModeLocal {
		b, err := os.ReadFile(localPath)
		if err != nil {
			return c, fmt.Errorf("TRACER_LOCAL_CONFIG: %w", err)
		}
		if c.Local, err = ParseLocal(b); err != nil {
			return c, err
		}
	}
	return c, nil
}

func (c Config) validate(localPath string) error {
	var problems []string
	if err := checkListen(c.Listen); err != nil {
		problems = append(problems, err.Error())
	}
	switch c.Mode {
	case ModeServer:
		if c.Stage == "" {
			problems = append(problems, "TRACER_STAGE is required")
		} else if _, ok := DefaultStageBytes[c.Stage]; !ok {
			problems = append(problems, "TRACER_STAGE must be dev or prod")
		}
		if err := checkConsoleURL(c.ConsoleURL); err != nil {
			problems = append(problems, err.Error())
		}
		if len(c.Token) < MinTokenLen {
			problems = append(problems, fmt.Sprintf("TRACER_TOKEN must be at least %d characters", MinTokenLen))
		}
		if c.DataDir == "" {
			problems = append(problems, "TRACER_DATA_DIR is required")
		}
		if localPath != "" {
			problems = append(problems, "TRACER_LOCAL_CONFIG is local mode only (unset TRACER_CONSOLE_URL)")
		}
		if c.DumpDir != "" {
			problems = append(problems, "TRACER_DUMP_DIR is local mode only (unset TRACER_CONSOLE_URL)")
		}
	case ModeLocal:
		if c.Token != "" {
			problems = append(problems, "TRACER_TOKEN needs TRACER_CONSOLE_URL")
		}
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, "TRACER_LOG_LEVEL must be debug|info|warn|error")
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// checkConsoleURL wants https: the read path forwards `yyt_` tokens to the
// console (decisions #7). Plain http is allowed only to a loopback host
// (a fake console in tests and local runs).
func checkConsoleURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("TRACER_CONSOLE_URL must be an absolute https URL")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("TRACER_CONSOLE_URL must be https (http only to a loopback IP)")
}

// checkListen requires a loopback IP literal in both modes: local mode
// because the static read token must never face a network
// (rules/security.md _Debug collector_), server mode because the container
// runs on the host network behind Caddy (docs/tracer.md _Operations_).
func checkListen(listen string) error {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("TRACER_LISTEN: %v", err)
	}
	if n, err := strconv.ParseUint(port, 10, 16); err != nil || n == 0 {
		return fmt.Errorf("TRACER_LISTEN %q: port must be 1..65535", listen)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("TRACER_LISTEN %q: host must be an IP literal", listen)
	}
	if ip.IsUnspecified() {
		return fmt.Errorf("TRACER_LISTEN %q binds every interface; use 127.0.0.1", listen)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("TRACER_LISTEN %q: listen on a loopback IP (Caddy fronts the host)", listen)
	}
	return nil
}

// LocalResource is one resource of `tracer.json`. The write key is given in
// plain text (curl and the capture builds need it) and hashed at load, so the
// ingest path compares hashes in both modes.
type LocalResource struct {
	ID         string `json:"id"`
	WriteKey   string `json:"writeKey"`
	DailyBytes int64  `json:"dailyBytes,omitempty"`
}

// LocalFile is `tracer.json`.
type LocalFile struct {
	Resources []LocalResource `json:"resources"`
	// ReadToken is the static `yyt_` token the read API accepts in local mode.
	ReadToken string `json:"readToken"`
	// KeyHashes maps resource id → sha256(writeKey); filled by ParseLocal.
	KeyHashes map[string][32]byte `json:"-"`
}

// DefaultDailyBytes is the soft `tracer.dailyBytes` (50 MiB) used when a
// local resource names none.
const DefaultDailyBytes = 50 << 20

// ParseLocal decodes and validates `tracer.json`.
func ParseLocal(b []byte) (*LocalFile, error) {
	var f LocalFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("tracer.json: %w", err)
	}
	if f.ReadToken != "" && !ReadTokenPattern.MatchString(f.ReadToken) {
		return nil, errors.New("tracer.json: readToken must be yyt_ + 48 lowercase hex")
	}
	f.KeyHashes = map[string][32]byte{}
	keys := map[string]bool{}
	for i, r := range f.Resources {
		if !ResourceIDPattern.MatchString(r.ID) {
			return nil, fmt.Errorf("tracer.json: resource %d: id must match %s", i, ResourceIDPattern)
		}
		if len(r.WriteKey) < 16 {
			return nil, fmt.Errorf("tracer.json: resource %s: writeKey must be at least 16 characters", r.ID)
		}
		if _, dup := f.KeyHashes[r.ID]; dup || keys[r.WriteKey] {
			return nil, fmt.Errorf("tracer.json: duplicate resource id or writeKey (%s)", r.ID)
		}
		if r.DailyBytes < 0 {
			return nil, fmt.Errorf("tracer.json: resource %s: dailyBytes must not be negative", r.ID)
		}
		if r.DailyBytes == 0 {
			f.Resources[i].DailyBytes = DefaultDailyBytes
		}
		keys[r.WriteKey] = true
		f.KeyHashes[r.ID] = sha256.Sum256([]byte(r.WriteKey))
	}
	return &f, nil
}

func def(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// secret reads NAME, or the file named by NAME_FILE (trailing whitespace
// trimmed). The file wins: it is the more deliberate of the two.
func secret(getenv func(string) string, name string) (string, error) {
	if path := getenv(name + "_FILE"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			// The error carries the path, never the content.
			return "", fmt.Errorf("%s_FILE: %w", name, err)
		}
		return strings.TrimRight(string(b), "\r\n\t "), nil
	}
	return getenv(name), nil
}

// Package config reads the gateway's process configuration from the
// environment. Every value the gateway needs at start-up is here; per-channel
// behaviour comes from the console (`internal/console`) and is never an
// environment variable.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the process-level configuration.
type Config struct {
	// Listen is the TCP address of the HTTP/WebSocket listener, e.g. ":8080".
	Listen string
	// Stage is the Redis namespace segment (`dev`/`prod`); it must match the
	// stage of the console this gateway reads channels from.
	Stage string
	// ConsoleURL is the base URL of the console API (no trailing slash).
	ConsoleURL string
	// Token is the shared secret for `GET /gw/channels/{id}`.
	Token string
	// RedisURL is a `redis://user:password@host:port/db` URL.
	RedisURL string
	// TLSCert/TLSKey enable in-process TLS when both are set.
	TLSCert string
	TLSKey  string
	// ConfigTTL is how long a channel config is cached (platform rule: 60s).
	ConfigTTL time.Duration
	// ShutdownTimeout bounds the SIGTERM drain sequence.
	ShutdownTimeout time.Duration
	// LogLevel is `debug`, `info`, `warn` or `error`.
	LogLevel string
	// MaxConnections caps live sockets (default 64).
	MaxConnections int
}

// MinTokenLen mirrors the console's `MIN_TOKEN_LEN`: below this a shared
// secret is not one, and the console would refuse it anyway.
const MinTokenLen = 32

// FromEnv builds a Config from `GATEWAY_*` variables. `GATEWAY_TOKEN_FILE` and
// `GATEWAY_REDIS_URL_FILE` are read instead of the plain variables when set, so
// a secret can be mounted as a file rather than sit in `docker inspect`.
func FromEnv(getenv func(string) string) (Config, error) {
	c := Config{
		Listen:          def(getenv("GATEWAY_LISTEN"), ":8080"),
		Stage:           getenv("GATEWAY_STAGE"),
		ConsoleURL:      strings.TrimRight(getenv("GATEWAY_CONSOLE_URL"), "/"),
		TLSCert:         getenv("GATEWAY_TLS_CERT"),
		TLSKey:          getenv("GATEWAY_TLS_KEY"),
		ConfigTTL:       60 * time.Second,
		ShutdownTimeout: 10 * time.Second,
		LogLevel:        def(getenv("GATEWAY_LOG_LEVEL"), "info"),
		MaxConnections:  64,
	}
	var err error
	if c.Token, err = secret(getenv, "GATEWAY_TOKEN"); err != nil {
		return c, err
	}
	if c.RedisURL, err = secret(getenv, "GATEWAY_REDIS_URL"); err != nil {
		return c, err
	}
	if v := getenv("GATEWAY_CONFIG_TTL_SEC"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, fmt.Errorf("GATEWAY_CONFIG_TTL_SEC: not a positive integer")
		}
		c.ConfigTTL = time.Duration(n) * time.Second
	}
	if v := getenv("GATEWAY_MAX_CONNECTIONS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, fmt.Errorf("GATEWAY_MAX_CONNECTIONS: not a positive integer")
		}
		c.MaxConnections = n
	}
	if v := getenv("GATEWAY_SHUTDOWN_TIMEOUT_SEC"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, fmt.Errorf("GATEWAY_SHUTDOWN_TIMEOUT_SEC: not a positive integer")
		}
		c.ShutdownTimeout = time.Duration(n) * time.Second
	}
	return c, c.validate()
}

func (c Config) validate() error {
	var problems []string
	if c.Stage == "" {
		problems = append(problems, "GATEWAY_STAGE is required")
	} else if strings.ContainsAny(c.Stage, ":* \t\n") {
		problems = append(problems, "GATEWAY_STAGE must not contain ':' or '*'")
	}
	if c.ConsoleURL == "" {
		problems = append(problems, "GATEWAY_CONSOLE_URL is required")
	} else if !strings.HasPrefix(c.ConsoleURL, "https://") && !strings.HasPrefix(c.ConsoleURL, "http://") {
		problems = append(problems, "GATEWAY_CONSOLE_URL must be http(s)")
	}
	if len(c.Token) < MinTokenLen {
		problems = append(problems, fmt.Sprintf("GATEWAY_TOKEN must be at least %d characters", MinTokenLen))
	}
	if c.RedisURL == "" {
		problems = append(problems, "GATEWAY_REDIS_URL is required")
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		problems = append(problems, "GATEWAY_TLS_CERT and GATEWAY_TLS_KEY must be set together")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, "GATEWAY_LOG_LEVEL must be debug|info|warn|error")
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func def(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// secret reads NAME, or the file named by NAME_FILE (trimmed of trailing
// whitespace). The file wins when both are set, since a file is the more
// deliberate of the two.
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

// Package selfupdate finds the newest `cli/v*` GitHub release and swaps the
// running binary for it. Archives are verified against the release's
// checksums.txt before anything is written next to the executable.
package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	Repo      = "yingyeothon/service"
	TagPrefix = "cli/v"
	// maxArchive bounds a release download; the binary is a few MB.
	maxArchive = 64 << 20
)

// Updater talks to GitHub; the URLs are fields so tests can point at a fake.
type Updater struct {
	// ReleasesAPI lists releases (GitHub `GET /repos/{repo}/releases`).
	ReleasesAPI string
	// DownloadBase is the prefix of `<tag-encoded>/<asset>` asset URLs.
	DownloadBase string
	HTTP         *http.Client
	OS, Arch     string
}

func New() *Updater {
	return &Updater{
		ReleasesAPI:  "https://api.github.com/repos/" + Repo + "/releases?per_page=100",
		DownloadBase: "https://github.com/" + Repo + "/releases/download/",
		HTTP:         &http.Client{Timeout: 5 * time.Minute},
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
	}
}

// Release is one `cli/v*` GitHub release.
type Release struct {
	Tag     string // "cli/v1.2.3"
	Version string // "1.2.3"
}

// Latest returns the newest `cli/v*` release by semantic version, ignoring
// drafts and prereleases. ErrNoRelease when none is published.
func (u *Updater) Latest(ctx context.Context) (Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.ReleasesAPI, nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "yyt-cli-selfupdate")
	// Unauthenticated api.github.com allows 60 requests/hour per address;
	// a token lifts that (never sent to the download host).
	for _, k := range []string{"GITHUB_TOKEN", "GH_TOKEN"} {
		if t := os.Getenv(k); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
			break
		}
	}
	res, err := u.HTTP.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		if (res.StatusCode == 403 || res.StatusCode == 429) && res.Header.Get("X-RateLimit-Remaining") == "0" {
			return Release{}, fmt.Errorf("release list: GitHub API rate limit reached; set GITHUB_TOKEN or retry later")
		}
		return Release{}, fmt.Errorf("release list: HTTP %d", res.StatusCode)
	}
	var rows []struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&rows); err != nil {
		return Release{}, fmt.Errorf("release list: %w", err)
	}
	var best Release
	var bestV [3]int
	for _, r := range rows {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, TagPrefix) {
			continue
		}
		v, ok := parseVersion(strings.TrimPrefix(r.Tag, TagPrefix))
		if !ok || strings.ContainsAny(r.Tag, "-+") { // pre-release/build tags are never "latest"
			continue
		}
		if best.Tag == "" || compare(v, bestV) > 0 {
			best, bestV = Release{Tag: r.Tag, Version: strings.TrimPrefix(r.Tag, TagPrefix)}, v
		}
	}
	if best.Tag == "" {
		return Release{}, ErrNoRelease
	}
	return best, nil
}

var ErrNoRelease = errors.New("no cli/v* release found")

// Compare orders two version strings; a non-semver string (e.g. "dev") sorts
// below every release so a dev build is always "older".
func Compare(a, b string) int {
	va, oka := parseVersion(a)
	vb, okb := parseVersion(b)
	switch {
	case !oka && !okb:
		return 0
	case !oka:
		return -1
	case !okb:
		return 1
	}
	return compare(va, vb)
}

// ParseRelease validates a user-supplied version ("1.2.0" or "v1.2.0") and
// returns the matching Release.
func ParseRelease(s string) (Release, error) {
	v := strings.TrimPrefix(strings.TrimSpace(s), "v")
	if _, ok := parseVersion(v); !ok || strings.ContainsAny(v, "-+") {
		return Release{}, fmt.Errorf("invalid version %q (expected MAJOR.MINOR.PATCH)", s)
	}
	return Release{Tag: TagPrefix + v, Version: v}, nil
}

func parseVersion(s string) ([3]int, bool) {
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 { // pre-release / build metadata
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var v [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		v[i] = n
	}
	return v, true
}

func compare(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// AssetName is the archive published for this platform.
func (u *Updater) AssetName(version string) string {
	ext := ".tar.gz"
	if u.OS == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("yyt_%s_%s_%s%s", version, u.OS, u.Arch, ext)
}

func (u *Updater) assetURL(rel Release, name string) string {
	return u.DownloadBase + strings.ReplaceAll(rel.Tag, "/", "%2F") + "/" + name
}

// Download fetches the platform archive and checksums.txt, verifies the
// SHA-256, and returns the extracted binary bytes.
func (u *Updater) Download(ctx context.Context, rel Release) ([]byte, error) {
	name := u.AssetName(rel.Version)
	archive, err := u.get(ctx, u.assetURL(rel, name), maxArchive)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w (the release may still be publishing or has no build for %s/%s; retry or pin --version)", name, err, u.OS, u.Arch)
	}
	sums, err := u.get(ctx, u.assetURL(rel, "checksums.txt"), 1<<20)
	if err != nil {
		return nil, fmt.Errorf("download checksums.txt: %w", err)
	}
	if err := verify(archive, name, sums); err != nil {
		return nil, err
	}
	bin := "yyt"
	if u.OS == "windows" {
		bin = "yyt.exe"
	}
	if strings.HasSuffix(name, ".zip") {
		return extractZip(archive, bin)
	}
	return extractTarGz(archive, bin)
}

func (u *Updater) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "yyt-cli-selfupdate")
	res, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("response too large")
	}
	return b, nil
}

// verify checks `archive` against the `<hex>  <name>` line of checksums.txt.
func verify(archive []byte, name string, sums []byte) error {
	sum := sha256.Sum256(archive)
	actual := hex.EncodeToString(sum[:])
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			if strings.EqualFold(f[0], actual) {
				return nil
			}
			return fmt.Errorf("checksum mismatch for %s", name)
		}
	}
	return fmt.Errorf("%s is not listed in checksums.txt", name)
}

func extractTarGz(archive []byte, bin string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && filepath.Base(h.Name) == bin {
			return io.ReadAll(io.LimitReader(tr, maxArchive))
		}
	}
	return nil, fmt.Errorf("%s not found in archive", bin)
}

func extractZip(archive []byte, bin string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if filepath.Base(f.Name) == bin && !f.FileInfo().IsDir() {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(io.LimitReader(rc, maxArchive))
		}
	}
	return nil, fmt.Errorf("%s not found in archive", bin)
}

// Replace atomically installs `bin` over `target`: it is written next to the
// target and renamed into place. On Windows the running executable cannot be
// overwritten, so it is first renamed to `<target>.old` (removed on the next
// successful update).
func Replace(target string, bin []byte) error {
	dir := filepath.Dir(target)
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	hint := func(err error) error {
		return fmt.Errorf("cannot replace %s: %w (if a package manager installed it, update through that manager; otherwise re-run with write access to the directory)", target, err)
	}
	tmp, err := os.CreateTemp(dir, ".yyt-update-*")
	if err != nil {
		return hint(err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	// Flush before the rename: a crash after an un-synced rename can persist
	// a truncated binary with the old one already gone.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Chmod(tmpName, info.Mode().Perm()); err != nil {
		cleanup()
		return hint(err)
	}
	old := target + ".old"
	if runtime.GOOS == "windows" {
		_ = os.Remove(old)
		if err := os.Rename(target, old); err != nil {
			cleanup()
			return fmt.Errorf("cannot move the running yyt.exe aside: %w (close other yyt processes and delete %s)", err, old)
		}
	}
	if err := os.Rename(tmpName, target); err != nil {
		cleanup()
		if runtime.GOOS == "windows" {
			_ = os.Rename(old, target)
		}
		return hint(err)
	}
	if runtime.GOOS != "windows" {
		_ = os.Remove(old)
	}
	return nil
}

// RemoveStale deletes the `<exe>.old` a previous Windows update left behind;
// best effort, silent (the file is locked while the old process runs).
func RemoveStale() {
	if runtime.GOOS != "windows" {
		return
	}
	if exe, err := ExecutablePath(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}

// ExecutablePath is the resolved path of the running binary.
func ExecutablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

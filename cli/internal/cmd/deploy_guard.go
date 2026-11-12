package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yingyeothon/service/cli/internal/android"
	"github.com/yingyeothon/service/cli/internal/flutter"
	"github.com/yingyeothon/service/cli/internal/textsafe"
)

// outputRunner runs a read-only helper (git, aapt2) and returns its stdout.
type outputRunner func(ctx context.Context, dir, name string, args ...string) ([]byte, error)

func execOutput(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if line, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n"); line != "" {
			return out, fmt.Errorf("%w: %s", err, textsafe.Clean(line))
		}
	}
	return out, err
}

// Swapped by tests: the helper runner and the aapt2 lookup.
var (
	deployOutput outputRunner = execOutput
	findAAPT2                 = android.FindAAPT2
)

// gitBase makes every git call here leave the repository untouched: without
// it `status` and `diff` refresh .git/index (taking index.lock under a script
// that runs git at the same time), and a configured fsmonitor command runs.
var gitBase = []string{"--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-c", "core.fsmonitor=false"}

// gitRaw runs a read-only git command in the project directory. deploy never
// runs a git command that writes (docs/decisions.md: pull, commit and push
// stay in the caller's script).
func gitRaw(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, err := deployOutput(ctx, dir, "git", append(append([]string{}, gitBase...), args...)...)
	if err != nil {
		return nil, fmt.Errorf("git %s: %w", args[0], err)
	}
	return out, nil
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := gitRaw(ctx, dir, args...)
	return strings.TrimSpace(string(out)), err
}

// hasDotGit reports whether dir or a parent holds a `.git` entry (swapped by
// tests, whose temporary directories may sit inside a repository).
var hasDotGit = dotGitAbove

func dotGitAbove(dir string) bool {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// inGitRepo reports whether dir is inside a git work tree. Only a directory
// with no `.git` above it is a no: a git that fails inside a checkout (not
// installed, "dubious ownership" on a CI mount, a `.git` file whose gitdir is
// not mounted) is an error, because reading it as "no repository" would
// switch the drift guard off unnoticed.
func inGitRepo(ctx context.Context, dir string) (bool, error) {
	out, err := git(ctx, dir, "rev-parse", "--is-inside-work-tree")
	if err == nil {
		return out == "true", nil
	}
	if !hasDotGit(dir) {
		return false, nil
	}
	return false, err
}

// lockfile is the one tracked file a build may rewrite (`flutter build` runs
// `pub get`); the caller's script commits it afterwards.
const lockfile = "pubspec.lock"

// gitState is what the drift guard compares between the start of the build
// and the upload.
type gitState struct {
	head    string   // "" in a repository without a commit
	changed []string // tracked files that differ from HEAD, pubspec.lock aside
	diff    string   // digest of their content difference
}

// statusPaths lists the paths of `git status --porcelain=v1 -z` output. With
// -z nothing is quoted, and a rename or copy is followed by its source path
// as a separate entry.
func statusPaths(out []byte) []string {
	var paths []string
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		paths = append(paths, e[3:])
		if e[0] == 'R' || e[0] == 'C' || e[1] == 'R' || e[1] == 'C' {
			i++
		}
	}
	return paths
}

// gitSnapshot records HEAD and the tracked changes of the whole repository
// that holds dir (an app may live in a subdirectory of it), submodule content
// included. Untracked files are not looked at: build outputs and local config
// are untracked. Files marked skip-worktree or assume-unchanged are invisible
// to git and so to this.
func gitSnapshot(ctx context.Context, dir string) (gitState, error) {
	var st gitState
	// An unborn HEAD is a state, not a failure: a new repository still deploys.
	st.head, _ = git(ctx, dir, "rev-parse", "-q", "--verify", "HEAD")
	status, err := gitRaw(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=no")
	if err != nil {
		return st, err
	}
	for _, p := range statusPaths(status) {
		if path.Base(p) != lockfile {
			st.changed = append(st.changed, p)
		}
	}
	sort.Strings(st.changed)
	if st.head == "" {
		return st, nil
	}
	// The status alone cannot tell a file that was already modified from one
	// modified again (nor a dirty submodule from one edited further), so the
	// content difference is compared too.
	diff, err := gitRaw(ctx, dir, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--binary", "--submodule=diff", "--",
		":(top)", ":(top,exclude,glob)**/"+lockfile)
	if err != nil {
		return st, err
	}
	sum := sha256.Sum256(diff)
	st.diff = hex.EncodeToString(sum[:])
	return st, nil
}

// short abbreviates a commit hash for a message.
func short(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}

// drift describes what changed between two snapshots; "" when nothing did.
func (st gitState) drift(now gitState) string {
	if st.head != now.head {
		return fmt.Sprintf("HEAD moved from %s to %s", short(st.head), short(now.head))
	}
	if strings.Join(st.changed, "\n") != strings.Join(now.changed, "\n") || st.diff != now.diff {
		was := map[string]bool{}
		for _, p := range st.changed {
			was[p] = true
		}
		var files []string
		for _, p := range now.changed {
			if !was[p] {
				files = append(files, p)
			}
		}
		if len(files) == 0 {
			return "tracked files changed again or were restored"
		}
		return "tracked files changed: " + summarize(files)
	}
	return ""
}

func summarize(files []string) string {
	const max = 5
	files = append([]string{}, files...)
	for i, f := range files {
		// A tracked file name is repository content; keep it off the terminal's controls.
		files[i] = textsafe.Clean(f)
	}
	if len(files) > max {
		return fmt.Sprintf("%s and %d more", strings.Join(files[:max], ", "), len(files)-max)
	}
	return strings.Join(files, ", ")
}

// maxNote is the console's cap on a tag value (500 UTF-16 units); bytes are
// the conservative count.
const maxNote = 500

// autoNote is the subject of the newest commit, from head back, that no skip
// pattern matches: the changelog of a build made right after a bump or
// lockfile commit is the commit before those. Control characters are removed
// (the tag is shown to other members) and the text is cut to the tag limit.
func autoNote(ctx context.Context, dir, head string, skips []*regexp.Regexp) (string, error) {
	const depth = 200
	out, err := git(ctx, dir, "-c", "log.showSignature=false", "log", "-n", strconv.Itoa(depth), "--format=%s", head)
	if err != nil {
		return "", err
	}
next:
	for _, subject := range strings.Split(out, "\n") {
		subject = strings.TrimSpace(textsafe.Clean(subject))
		if subject == "" {
			continue
		}
		for _, re := range skips {
			if re.MatchString(subject) {
				continue next
			}
		}
		for len(subject) > maxNote {
			_, size := utf8.DecodeLastRuneInString(subject)
			subject = subject[:len(subject)-size]
		}
		return strings.TrimSpace(subject), nil
	}
	return "", fmt.Errorf("--note auto: none of the last %d commit subjects is left after --note-skip", depth)
}

// artifactInfo is what was read back from one built file.
type artifactInfo struct {
	id          string // packaged application id; "" when nothing could read it
	versionCode int    // 0 when nothing could read it
	minSdk      string
	targetSdk   string
}

// aapt2Lookup finds aapt2 once per run and proves it runs.
type aapt2Lookup struct {
	project string
	done    bool
	path    string
	err     error
	broken  error // found, but `aapt2 version` failed
}

func (l *aapt2Lookup) get(ctx context.Context) (string, error) {
	if l.done {
		return l.path, l.err
	}
	l.done = true
	if l.path, l.err = findAAPT2(sdkDirOf(l.project)); l.err != nil {
		return l.path, l.err
	}
	// An x86_64 aapt2 on an arm64 host, or a file that is not a program, is
	// found by name and fails on every file: learn that before the build.
	if _, err := deployOutput(ctx, "", l.path, "version"); err != nil {
		l.broken = fmt.Errorf("%s does not run: %w", l.path, err)
		if os.Getenv("AAPT2") != "" {
			// The caller named this tool; do not quietly work without it.
			l.err = l.broken
		} else {
			l.err = android.ErrNoAAPT2
		}
		l.path = ""
	}
	return l.path, l.err
}

// sdkDirOf reads `sdk.dir` from android/local.properties, which Flutter
// writes on every build: the SDK the build itself uses.
func sdkDirOf(project string) string {
	data, err := os.ReadFile(filepath.Join(project, "android", "local.properties"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, val, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.TrimSpace(key) != "sdk.dir" {
			continue
		}
		// Java properties escaping, as Android Studio writes Windows paths.
		val = strings.NewReplacer(`\\`, `\`, `\:`, `:`).Replace(strings.TrimSpace(val))
		return val
	}
	return ""
}

// inspectArtifact reads the packaged id, versionCode and SDK levels of one
// build output. An APK is described by Gradle's output metadata and, when
// aapt2 is installed, by its own manifest; the two must agree, since a stale
// metadata file would otherwise vouch for the wrong APK. A bundle has no
// metadata, so only aapt2 can read it. Nothing readable is not an error here:
// the caller decides whether an unread value may be uploaded.
func inspectArtifact(ctx context.Context, tools *aapt2Lookup, out buildOutput, kind string, meta *flutter.BuildMetadata) (artifactInfo, error) {
	var info artifactInfo
	if kind == "apk" && meta != nil {
		info.id = meta.ApplicationID
		info.versionCode = meta.VersionCode(out.abi)
	}
	aapt2, err := tools.get(ctx)
	if errors.Is(err, android.ErrNoAAPT2) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	// Absolute: a relative path that starts with "-" must not read as an option.
	file, err := filepath.Abs(out.path)
	if err != nil {
		return info, err
	}
	run := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return deployOutput(ctx, "", name, args...)
	}
	var read android.Info
	if kind == "apk" {
		read, err = android.InspectAPK(ctx, run, aapt2, file)
	} else {
		read, err = android.InspectAAB(ctx, run, aapt2, file)
	}
	if err != nil {
		// An installed aapt2 that cannot read the file it is asked about is
		// never "unchecked": the file may not be what the build claims.
		return info, err
	}
	if info.id != "" && info.id != read.Package {
		return info, fmt.Errorf("%s is packaged as %s but Gradle's output metadata says %s (stale build output?)", out.path, read.Package, info.id)
	}
	if info.versionCode != 0 && info.versionCode != read.VersionCode {
		return info, fmt.Errorf("%s has versionCode %d but Gradle's output metadata says %d (stale build output?)", out.path, read.VersionCode, info.versionCode)
	}
	return artifactInfo{id: read.Package, versionCode: read.VersionCode, minSdk: read.MinSdk, targetSdk: read.TargetSdk}, nil
}

// checkVersionCode enforces --version-code-offset on one file: the packaged
// versionCode must be offset + the pubspec build number. A value nothing
// could read fails; a check that was asked for never passes by default.
func checkVersionCode(out buildOutput, info artifactInfo, offset, build int) error {
	want := offset + build
	if info.versionCode == 0 {
		return fmt.Errorf("cannot read the versionCode of %s (no Gradle output metadata for it, and %v): not uploading", out.path, android.ErrNoAAPT2)
	}
	if info.versionCode == want {
		return nil
	}
	hint := ""
	if out.abi != "" {
		hint = "; with --split-per-abi Flutter adds an ABI offset unless android/gradle.properties sets force-version-code-ignoring-abi=true"
	}
	return fmt.Errorf("%s has versionCode %d, expected %d (offset %d + pubspec build %d)%s", out.path, info.versionCode, want, offset, build, hint)
}

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"

	"github.com/yingyeothon/service/cli/internal/textsafe"
)

// buildConfig is the `build` object of the project's .yyt.json: the build
// defaults a consumer's deploy script used to carry. Flags override it.
// Unknown keys are errors: a typo must not switch a guard off.
type buildConfig struct {
	RequireFlutter string   `json:"requireFlutter"`
	Prebuild       string   `json:"prebuild"`
	Create         *bool    `json:"create"`
	VersionTag     string   `json:"versionTag"`
	Commit         string   `json:"commit"`
	Note           string   `json:"note"`
	NoteSkip       []string `json:"noteSkip"`

	Android *platformBuild `json:"android"`
	// IOS is read by `--platform ios`.
	IOS json.RawMessage `json:"ios"`
}

// platformBuild holds the per-platform defaults and the per-profile values.
type platformBuild struct {
	SplitPerAbi       *bool                   `json:"splitPerAbi"`
	TargetPlatform    string                  `json:"targetPlatform"`
	VersionCodeOffset *int                    `json:"versionCodeOffset"`
	VersionTag        string                  `json:"versionTag"`
	Profiles          map[string]profileBuild `json:"profiles"`
}

// profileBuild is what one --build-profile adds. dartDefines are key names
// only: the values always come from the environment, so nothing secret is
// committed and a debug-only define cannot reach a release build of the
// same run.
type profileBuild struct {
	Stage           string   `json:"stage"`
	DartDefines     []string `json:"dartDefines"`
	DartDefineFiles []string `json:"dartDefineFiles"`
	SplitPerAbi     *bool    `json:"splitPerAbi"`
	// A pointer: "" clears the platform's value for this profile (a store
	// bundle must not inherit the APK's android-arm64).
	TargetPlatform *string `json:"targetPlatform"`
}

// findBuildConfig reads `build` from the .yyt.json in the project directory
// itself, with the rules of findVariants: no upward walk, and a file that
// cannot be read as written is an error. path is "" when there is no `build`.
func findBuildConfig(projectPath string) (buildConfig, string, error) {
	var cfg buildConfig
	p := filepath.Join(projectPath, ContextFile)
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return cfg, "", nil
	}
	if err != nil {
		// Unreadable is not absent: the file may hold the guards.
		return cfg, "", fmt.Errorf("%s: %w", p, err)
	}
	var doc struct {
		Build json.RawMessage `json:"build"`
	}
	parseErr := json.Unmarshal(b, &doc)
	if dirWorldWritable(projectPath) {
		// Anyone can plant a file here. The team/project search and the
		// variants skip it; a build config names a script to run, so one
		// that is present is refused out loud, and a file that does not
		// parse is left alone like everywhere else.
		if parseErr == nil && len(doc.Build) > 0 && string(doc.Build) != "null" {
			return cfg, "", fmt.Errorf("%s: \"build\" is not read from a world-writable directory", p)
		}
		return cfg, "", nil
	}
	if parseErr != nil {
		return cfg, "", fmt.Errorf("%s: %w", p, parseErr)
	}
	// encoding/json keeps the last of two equal keys: a merge leftover
	// (`"create": false` twice, or a second `"build": null`) would switch
	// the first one off without a word.
	if err := duplicateKey(b, 1, "build"); err != nil {
		return cfg, "", fmt.Errorf("%s: %w", p, err)
	}
	if len(doc.Build) == 0 || string(doc.Build) == "null" {
		return cfg, "", nil
	}
	if err := duplicateKey(doc.Build, -1, ""); err != nil {
		return cfg, "", fmt.Errorf("%s: \"build\": %w", p, err)
	}
	if err := misspelledKey(doc.Build); err != nil {
		return cfg, "", fmt.Errorf("%s: \"build\": %w", p, err)
	}
	dec := json.NewDecoder(bytes.NewReader(doc.Build))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return cfg, "", fmt.Errorf("%s: \"build\": %w", p, err)
	}
	if err := cfg.validate(); err != nil {
		return cfg, "", fmt.Errorf("%s: \"build\": %w", p, err)
	}
	return cfg, p, nil
}

func (c buildConfig) validate() error {
	for name, v := range map[string]string{"commit": c.Commit, "note": c.Note} {
		// A literal commit or changelog in a committed file is stale by the
		// next build.
		if v != "" && v != "auto" {
			return fmt.Errorf("%q may only be \"auto\"", name)
		}
	}
	if c.RequireFlutter != "" && !flutterVersionText.MatchString(c.RequireFlutter) {
		return errors.New("requireFlutter must be a version such as 3.47.8")
	}
	if textsafe.Clean(c.Prebuild) != c.Prebuild || strings.ContainsAny(c.Prebuild, "\r\n") {
		return errors.New("prebuild has control characters")
	}
	tags := []string{c.VersionTag}
	if c.Android != nil {
		tags = append(tags, c.Android.VersionTag)
		if off := c.Android.VersionCodeOffset; off != nil && *off < 0 {
			return errors.New("android.versionCodeOffset must not be negative")
		}
		if err := checkTargetPlatform("android.targetPlatform", c.Android.TargetPlatform); err != nil {
			return err
		}
		for name, p := range c.Android.Profiles {
			if _, ok := profileSpecs[name]; !ok {
				return fmt.Errorf("android.profiles: unknown profile %q (debug|release|appbundle)", name)
			}
			seen := map[string]bool{}
			for _, k := range p.DartDefines {
				// A value here would be a secret in a committed file.
				if !defineKey.MatchString(k) {
					return fmt.Errorf("android.profiles.%s.dartDefines: entries are key names like MY_KEY; values come from the environment", name)
				}
				// A define is compiled into the artifact that gets uploaded:
				// a data-only change must not ship the CLI's own credentials.
				if strings.HasPrefix(k, "YYT_") {
					return fmt.Errorf("android.profiles.%s.dartDefines: %s is the CLI's own environment and cannot be a define", name, k)
				}
				if seen[k] {
					return fmt.Errorf("android.profiles.%s.dartDefines: %s is listed twice", name, k)
				}
				seen[k] = true
			}
			if p.TargetPlatform != nil && *p.TargetPlatform != "" {
				if err := checkTargetPlatform("android.profiles."+name+".targetPlatform", *p.TargetPlatform); err != nil {
					return err
				}
			}
			if textsafe.Clean(p.Stage) != p.Stage || strings.ContainsAny(p.Stage, "\r\n") {
				return fmt.Errorf("android.profiles.%s.stage has control characters", name)
			}
		}
	}
	for _, t := range tags {
		if t != "" && t != "full" && t != "marketing" {
			return fmt.Errorf("versionTag %q (full|marketing)", t)
		}
	}
	return nil
}

var (
	flutterVersionText = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]*$`)
	targetPlatformText = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$`)
)

func checkTargetPlatform(where, v string) error {
	if v != "" && !targetPlatformText.MatchString(v) {
		return fmt.Errorf("%s must look like android-arm64[,android-arm]", where)
	}
	return nil
}

// duplicateKey reports an object key that appears twice. depth limits how far
// down it looks (-1 = everywhere) and only bounds the top-level scan to the
// named key, since unknown top-level keys are not this command's to judge.
func duplicateKey(raw []byte, depth int, only string) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var walk func(level int) error
	walk = func(level int) error {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		seen := map[string]bool{}
		for dec.More() {
			if delim == '{' {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				key, _ := kt.(string)
				if (depth < 0 || level < depth) && (only == "" || key == only) {
					if seen[key] {
						return fmt.Errorf("the key %q appears twice", key)
					}
					seen[key] = true
				}
			}
			if err := walk(level + 1); err != nil {
				return err
			}
		}
		_, err = dec.Token()
		return err
	}
	return walk(0)
}

// buildKeys are the key spellings the config knows. encoding/json matches
// keys without regard to case, so "PreBuild" would work on one machine's
// file and read as a typo to everyone else; only the documented spelling is
// accepted.
var buildKeys = func() map[string]string {
	out := map[string]string{}
	for _, v := range []any{buildConfig{}, platformBuild{}, profileBuild{}} {
		t := reflect.TypeOf(v)
		for i := 0; i < t.NumField(); i++ {
			name := t.Field(i).Tag.Get("json")
			out[strings.ToLower(name)] = name
		}
	}
	for name := range profileSpecs {
		out[strings.ToLower(name)] = name
	}
	return out
}()

func misspelledKey(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var walk func(skip bool) error
	walk = func(skip bool) error {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		for dec.More() {
			inner := skip
			if delim == '{' {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				key, _ := kt.(string)
				if want, known := buildKeys[strings.ToLower(key)]; !skip && known && want != key {
					return fmt.Errorf("the key %q must be spelled %q", key, want)
				}
				// The ios subtree belongs to `--platform ios`.
				inner = skip || key == "ios"
			}
			if err := walk(inner); err != nil {
				return err
			}
		}
		_, err = dec.Token()
		return err
	}
	return walk(false)
}

// profilePlan is what one --build-profile will build, after the config and
// the flags are merged.
type profilePlan struct {
	Profile        string   `json:"profile"`
	Stage          string   `json:"stage,omitempty"`
	SplitPerAbi    bool     `json:"splitPerAbi"`
	TargetPlatform string   `json:"targetPlatform,omitempty"`
	DefineKeys     []string `json:"dartDefines,omitempty"`
	DefineFiles    []string `json:"dartDefineFiles,omitempty"`
	// Flutter is the `flutter` command line with define values masked.
	Flutter []string `json:"flutter"`

	spec profileSpec
	args []string // the real command line
}

// unsetDefine stands in --print-config for a key the environment lacks, so a
// comparison before switching a script over shows what the real run will miss.
const unsetDefine = "<unset>"

// maskDefines hides the value of every --dart-define argument.
func maskDefines(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = a
		if rest, ok := strings.CutPrefix(a, "--dart-define="); ok {
			key, val, _ := strings.Cut(rest, "=")
			if val != unsetDefine {
				val = "***"
			}
			out[i] = "--dart-define=" + key + "=" + val
		}
	}
	return out
}

// insideProject resolves a path the config names relative to the project
// root and refuses anything that leaves it: an absolute path, `..`, or a
// symlink that points outside. A guard against mistakes and against a config
// reaching for files elsewhere on the machine, not a sandbox: what it admits
// is project content, like the build itself.
func insideProject(projectPath, what, rel string) (string, error) {
	bad := func(why string) (string, error) {
		return "", fmt.Errorf("%s %q: %s", what, rel, why)
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) || filepath.VolumeName(rel) != "" {
		return bad("must be a path relative to the project directory")
	}
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return bad("must stay inside the project directory")
		}
	}
	root, err := filepath.Abs(projectPath)
	if err != nil {
		return "", err
	}
	if root, err = filepath.EvalSymlinks(root); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return bad(err.Error())
	}
	if inside, err := filepath.Rel(root, resolved); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
		return bad("resolves outside the project directory")
	}
	if st, err := os.Stat(resolved); err != nil || !st.Mode().IsRegular() {
		return bad("is not a regular file")
	}
	return resolved, nil
}

// hookPath resolves the prebuild script. Beyond staying inside the project it
// must be runnable now (a script that cannot start would be found out only
// after the bump) and not replaceable by another local user.
func hookPath(projectPath, rel string) (string, error) {
	if rel == "" {
		return "", nil
	}
	resolved, err := insideProject(projectPath, "prebuild", rel)
	if err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(resolved)
		if err != nil {
			return "", err
		}
		if st.Mode().Perm()&0o111 == 0 {
			return "", fmt.Errorf("prebuild %q: is not executable (chmod +x)", rel)
		}
		if st.Mode().Perm()&0o002 != 0 || dirWorldWritable(filepath.Dir(resolved)) {
			return "", fmt.Errorf("prebuild %q: the script or its directory is world-writable", rel)
		}
	}
	return resolved, nil
}

// flutterVersion asks the flutter on PATH for its framework version.
func flutterVersion(ctx context.Context, projectPath string) (string, error) {
	out, err := deployOutput(ctx, projectPath, "flutter", "--version", "--machine")
	if err != nil {
		return "", fmt.Errorf("flutter --version: %w", err)
	}
	// Flutter may print a banner before or after the JSON object: take the
	// first position from which an object with the field decodes.
	var v struct {
		FrameworkVersion string `json:"frameworkVersion"`
	}
	for i := bytes.IndexByte(out, '{'); i >= 0 && i < len(out); {
		v.FrameworkVersion = ""
		if json.NewDecoder(bytes.NewReader(out[i:])).Decode(&v) == nil && v.FrameworkVersion != "" {
			break
		}
		next := bytes.IndexByte(out[i+1:], '{')
		if next < 0 {
			break
		}
		i += 1 + next
	}
	if v.FrameworkVersion == "" {
		return "", errors.New("flutter --version --machine did not report a frameworkVersion")
	}
	return v.FrameworkVersion, nil
}

package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/android"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/flutter"
	"github.com/yingyeothon/service/cli/internal/textsafe"
)

// commandRunner lets tests fake `flutter build`.
type commandRunner func(ctx context.Context, dir, name string, args ...string) error

func execRunner(ctx context.Context, dir, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// profileSpec is what one --build-profile means to `flutter build`.
type profileSpec struct {
	kind string // flutter build subcommand: apk | appbundle
	mode string // Gradle build type: debug | release
	ext  string
}

var profileSpecs = map[string]profileSpec{
	"debug":     {"apk", "debug", ".apk"},
	"release":   {"apk", "release", ".apk"},
	"appbundle": {"appbundle", "release", ".aab"},
}

// splitABIs are the ABI names `flutter build apk --split-per-abi` can emit.
// Split outputs are looked up by these names, never by a wildcard: with
// flavors, app-*-release.apk would also match app-<flavor>-release.apk and
// another flavor's leftovers.
var splitABIs = []string{"armeabi-v7a", "arm64-v8a", "x86", "x86_64"}

// Runner is swapped by tests; the default shells out to `flutter`.
var deployRunner commandRunner = execRunner

// verifyDelay is the pause between upload-verification retries (tests shrink it).
var verifyDelay = 2 * time.Second

// normalizeProfile maps legacy aliases (cata used "aab") to the server enum.
func normalizeProfile(pr string) string {
	if pr == "aab" {
		return "appbundle"
	}
	return pr
}

// buildOutput is one file produced by a flutter build.
type buildOutput struct {
	path string
	abi  string // non-empty for --split-per-abi APKs
	info artifactInfo
}

func outputsDir(projectPath string) string {
	return filepath.Join(projectPath, "build", "app", "outputs")
}

// apkPath is where Flutter copies an APK: app[-<abi>][-<flavor>]-<mode>.apk,
// the flavor in lower case.
func apkPath(projectPath, abi, flavor, mode string) string {
	parts := []string{"app"}
	if abi != "" {
		parts = append(parts, abi)
	}
	if flavor != "" {
		parts = append(parts, strings.ToLower(flavor))
	}
	parts = append(parts, mode)
	return filepath.Join(outputsDir(projectPath), "flutter-apk", strings.Join(parts, "-")+".apk")
}

// aabPaths lists the release bundles of a flavor. Without a flavor the path is
// fixed. With one, Gradle writes bundle/<flavor>Release/app-<flavor>-release.aab
// in its own variant-name case, so directory and file are matched
// case-insensitively.
func aabPaths(projectPath, flavor string) ([]string, error) {
	base := filepath.Join(outputsDir(projectPath), "bundle")
	if flavor == "" {
		return []string{filepath.Join(base, "release", "app-release.aab")}, nil
	}
	// ReadDir, not Glob: the project path is not a pattern.
	dirs, err := os.ReadDir(base)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var found []string
	for _, d := range dirs {
		if !d.IsDir() || !strings.EqualFold(d.Name(), flavor+"release") {
			continue
		}
		files, err := os.ReadDir(filepath.Join(base, d.Name()))
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			// Gradle spells a multi-dimension flavor its own way in the
			// file name, so only the directory pins the flavor.
			if strings.HasSuffix(strings.ToLower(f.Name()), "release.aab") {
				found = append(found, filepath.Join(base, d.Name(), f.Name()))
			}
		}
	}
	return found, nil
}

// cleanBuildOutputs removes every previous output the post-build lookup could
// take for this profile and flavor, and Gradle's output metadata, so a stale
// file from an earlier build (a wider --target-platform, another application
// id) is never uploaded or trusted under the new version.
func cleanBuildOutputs(projectPath, pr, flavor string) error {
	spec := profileSpecs[pr]
	var paths []string
	if spec.kind == "apk" {
		paths = append(paths, apkPath(projectPath, "", flavor, spec.mode))
		for _, abi := range splitABIs {
			paths = append(paths, apkPath(projectPath, abi, flavor, spec.mode))
		}
		if meta := flutter.OutputMetadataPath(projectPath, flavor, spec.mode); meta != "" {
			paths = append(paths, meta)
		}
	} else {
		aabs, err := aabPaths(projectPath, flavor)
		if err != nil {
			return err
		}
		paths = append(paths, aabs...)
	}
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale build output %s: %w", p, err)
		}
	}
	return nil
}

// buildOutputs locates the files a profile build produced.
func buildOutputs(projectPath, pr, flavor string, splitPerAbi bool) ([]buildOutput, error) {
	spec := profileSpecs[pr]
	if spec.kind != "apk" {
		aabs, err := aabPaths(projectPath, flavor)
		if err != nil {
			return nil, err
		}
		if len(aabs) != 1 {
			return nil, fmt.Errorf("expected exactly one bundle/%sRelease/*-release.aab (any case) under %s, found %d",
				flavor, outputsDir(projectPath), len(aabs))
		}
		return []buildOutput{{path: aabs[0]}}, nil
	}
	if !splitPerAbi {
		return []buildOutput{{path: apkPath(projectPath, "", flavor, spec.mode)}}, nil
	}
	var outs []buildOutput
	for _, abi := range splitABIs {
		p := apkPath(projectPath, abi, flavor, spec.mode)
		if _, err := os.Stat(p); err == nil {
			outs = append(outs, buildOutput{path: p, abi: abi})
		}
	}
	if len(outs) == 0 {
		return nil, fmt.Errorf("no split APKs found (expected %s)",
			apkPath(projectPath, "<abi>", flavor, spec.mode))
	}
	sort.Slice(outs, func(i, j int) bool { return outs[i].path < outs[j].path })
	return outs, nil
}

// checkBuiltID compares the applicationId Gradle packaged with the id the
// caller expects. It must match exactly; a debug build may also carry the
// conventional ".debug" suffix. Nothing looser: variant ids nest
// (com.example.app and com.example.app.pro), so a prefix test, or "one more
// segment", would accept the pro build as the base app's. A project with
// another debug suffix passes the full debug id as --application-id.
func checkBuiltID(expected, built, mode string) error {
	if built == expected || (mode == "debug" && built == expected+".debug") {
		return nil
	}
	return fmt.Errorf("built applicationId %q does not match the expected %q for a %s build (wrong --flavor/--variant, or pass the id this build really has as --application-id)", built, expected, mode)
}

var defineKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// dartDefineArgs turns --dart-define and --dart-define-from-file values into
// flutter arguments. `K=V` is passed through; a bare `K` takes its value from
// the environment and fails when it is unset or empty, because an empty define
// builds an app that silently runs with the default. Files are checked here
// for the same reason: flutter ignores a missing --dart-define-from-file.
// keys is what may be printed; values never are. lenient (--print-config)
// accepts a key the environment does not have.
func dartDefineArgs(defines, files []string, lenient bool) (args, keys []string, err error) {
	for i, d := range defines {
		key, val, hasVal := strings.Cut(d, "=")
		// The argument is never echoed: a quoting slip puts the value where
		// the key should be, and this message ends up in a CI log.
		if !defineKey.MatchString(key) {
			return nil, nil, fmt.Errorf("--dart-define #%d: the key is not a name like MY_KEY (use KEY=VALUE, or KEY to read the environment)", i+1)
		}
		if hasVal && val == "" {
			return nil, nil, fmt.Errorf("--dart-define %s=: the value is empty", key)
		}
		if !hasVal {
			val = os.Getenv(key)
			if val == "" && lenient {
				// --print-config shows the command line without the secrets.
				val = unsetDefine
			}
			if val == "" {
				return nil, nil, fmt.Errorf("--dart-define %s: %s is not set (or empty) in the environment", key, key)
			}
		}
		args = append(args, "--dart-define="+key+"="+val)
		keys = append(keys, key)
	}
	for _, f := range files {
		abs, err := filepath.Abs(f)
		if err != nil {
			return nil, nil, err
		}
		st, err := os.Stat(abs)
		if err != nil {
			return nil, nil, fmt.Errorf("--dart-define-from-file: %w", err)
		}
		if st.IsDir() {
			return nil, nil, fmt.Errorf("--dart-define-from-file: %s is a directory", abs)
		}
		args = append(args, "--dart-define-from-file="+abs)
	}
	return args, keys, nil
}

// reservedBuildFlags may not come after `--`: each has a deploy flag of its
// own, or changes the output path, the application id or the version tag
// behind deploy's back, or makes flutter print the defines. A guard against
// mistakes, not a boundary: the caller runs flutter either way.
var reservedBuildFlags = map[string]string{
	"--flavor":                "use --flavor or --variant",
	"--debug":                 "use --build-profile",
	"--release":               "use --build-profile",
	"--profile":               "not a supported build profile",
	"--split-per-abi":         "use --split-per-abi",
	"--no-split-per-abi":      "use --split-per-abi",
	"--target-platform":       "use --target-platform",
	"--dart-define":           "use --dart-define",
	"--dart-define-from-file": "use --dart-define-from-file",
	"--build-name":            "the version comes from pubspec.yaml",
	"--build-number":          "the version comes from pubspec.yaml",
	"--android-project-arg":   "Gradle properties can override what deploy set",
	"-P":                      "Gradle properties can override what deploy set",
	"--verbose":               "verbose output prints the dart defines",
	"-v":                      "verbose output prints the dart defines",
}

func checkPassthrough(args []string) error {
	for _, arg := range args {
		name, _, _ := strings.Cut(arg, "=")
		if strings.HasPrefix(arg, "-P") {
			name = "-P"
		}
		if hint, ok := reservedBuildFlags[name]; ok {
			return fmt.Errorf("%s cannot be passed after --: %s", name, hint)
		}
	}
	return nil
}

// resolveVariant picks the --variant preset from .yyt.json. A project that
// declares variants must be built as one of them (or with an explicit
// --flavor): a default build would upload some edition into whichever app the
// applicationId regex happens to name.
func resolveVariant(projectPath, variant, flavor string, upload bool) (string, variantPreset, error) {
	none := variantPreset{}
	vars, path, err := findVariants(projectPath)
	if err != nil {
		return "", none, err
	}
	names := make([]string, 0, len(vars))
	apps := map[string]string{}
	for n := range vars {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		app := strings.ToLower(vars[n].App)
		if other, dup := apps[app]; dup && app != "" {
			return "", none, fmt.Errorf("%s: variants %s and %s share the app %q; each variant needs its own catalog app", path, other, n, vars[n].App)
		}
		apps[app] = n
	}
	if variant == "" {
		if len(vars) == 0 {
			return "", none, nil
		}
		if flavor == "" {
			return "", none, fmt.Errorf("%s declares variants (%s): pass --variant", path, strings.Join(names, ", "))
		}
		// A bare --flavor that a preset describes is that variant: its app
		// and id apply, so flags cannot route the build somewhere else.
		var match []string
		for _, n := range names {
			if vars[n].Flavor == flavor {
				match = append(match, n)
			}
		}
		switch len(match) {
		case 0:
			return "", none, nil
		case 1:
			variant = match[0]
		default:
			return "", none, fmt.Errorf("%s: variants %s all build flavor %s: pass --variant", path, strings.Join(match, ", "), flavor)
		}
	}
	if len(vars) == 0 {
		return "", none, fmt.Errorf("--variant %s: %s has no \"variants\"", variant, filepath.Join(projectPath, ContextFile))
	}
	p, ok := vars[variant]
	if !ok {
		return "", none, fmt.Errorf("--variant %s is not in %s (%s)", variant, path, strings.Join(names, ", "))
	}
	if p.Flavor == "" {
		return "", none, fmt.Errorf("%s: variant %s has no \"flavor\"", path, variant)
	}
	// A file must name the app: an id would skip the team lookup and could
	// point the upload at an app of another team.
	if IsID(p.App) {
		return "", none, fmt.Errorf("%s: variant %s: \"app\" must be an app name, not an id", path, variant)
	}
	if upload && (p.App == "" || p.ApplicationID == "") {
		return "", none, fmt.Errorf("%s: variant %s needs \"app\" and \"applicationId\" for an upload", path, variant)
	}
	return variant, p, nil
}

// mergePreset layers a flag over a preset value; they may not disagree.
func mergePreset(flag, flagVal, presetVal, variant string) (string, error) {
	if presetVal == "" || flagVal == presetVal {
		return flagVal, nil
	}
	if flagVal == "" {
		return presetVal, nil
	}
	return "", fmt.Errorf("%s %s disagrees with variant %s (%s)", flag, flagVal, variant, presetVal)
}

var (
	flavorName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)
	androidID  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`)
)

// checkIdentity validates the values that end up in file paths and flutter
// arguments, wherever they came from (flag or .yyt.json).
func checkIdentity(flavor, name, applicationID string) error {
	if flavor != "" && !flavorName.MatchString(flavor) {
		return fmt.Errorf("invalid flavor %q (letters, digits and _ only)", flavor)
	}
	if strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, "-") || strings.HasPrefix(name, ".") {
		return fmt.Errorf("invalid app name %q", name)
	}
	if applicationID != "" && !androidID.MatchString(applicationID) {
		return fmt.Errorf("invalid application id %q (expected a dotted id such as com.example.app)", applicationID)
	}
	return nil
}

// argsBeforeDash counts positional arguments that are not passthrough.
func argsBeforeDash(cmd *cobra.Command, args []string) int {
	if n := cmd.ArgsLenAtDash(); n >= 0 {
		return n
	}
	return len(args)
}

// builtFile is one --no-upload result.
type builtFile struct {
	Path          string `json:"path"`
	BuildType     string `json:"buildType"`
	ABI           string `json:"abi,omitempty"`
	ApplicationID string `json:"applicationId,omitempty"`
	VersionCode   int    `json:"versionCode,omitempty"`
}

func newCatalogDeploy(a *App) *cobra.Command {
	var (
		name           string
		projectPath    string
		profiles       []string
		description    string
		stage          string
		changelog      string
		bump           string
		doBump         bool
		splitPerAbi    bool
		targetPlatform string
		buildNo        string
		commit         string
		minSdk         string
		targetSdk      string
		abiTag         string
		extraTags      []string
		noVerify       bool
		flavor         string
		variant        string
		expectedID     string
		defines        []string
		defineFiles    []string
		noUpload       bool
		vcOffset       int
		versionTag     string
		noCreate       bool
		noteSkips      []string
		noDriftCheck   bool
		requireClean   bool
		prebuild       string
		noPrebuild     bool
		requireFlutter string
		printConfig    bool
	)
	c := &cobra.Command{
		Use:   "deploy [flags] [-- <flutter build args>]",
		Short: "Build a Flutter Android app and upload the artifacts",
		Long: `Reads pubspec.yaml / build.gradle from --project-path, finds the app by name in
the team context (explicit: --team, YYT_TEAM, ` + ContextFile + ` next to the project, or
` + "`yyt team use`" + `), runs "flutter build" for each --build-profile, uploads the outputs
with version/build_type/application_id tags, and verifies the upload by re-reading
the artifact list. A missing app is created in the project context if one is set
(--project/YYT_PROJECT/...), else in the project named after the --project-path
directory (created when missing).

Flavors: --flavor builds one Gradle product flavor; with it, --name and
--application-id (the release id of that flavor) are required for an upload.
--variant <v> takes all three from ` + ContextFile + `:
  {"variants": {"pro": {"flavor": "pro", "app": "sample-pro", "applicationId": "com.example.sample.pro"}}}
A project whose ` + ContextFile + ` declares variants must be built with --variant or --flavor.
After an APK build the applicationId Gradle packaged (output-metadata.json) is
compared with the expected one: a release build must match it exactly, a debug
build may also carry the .debug suffix; a mismatch stops before the upload,
and so does a flavored APK that neither that metadata nor aapt2 can describe. The packaged id is what the
application_id tag carries. A bundle (.aab) has no such metadata: with aapt2
installed (AAPT2, or the Android SDK build-tools) its id is checked the same
way, otherwise it is tagged with the expected id unchecked.

Checks on the built file: the packaged versionCode is the version_code tag and
min_sdk/target_sdk are read from the file when aapt2 is installed.
--version-code-offset <n> requires every output to carry n + the pubspec build
number; a value nothing can read (a bundle without aapt2) fails the check.

Git is read, never written: --commit auto, --note auto (the newest subject no
--note-skip matches), --require-clean, and a drift guard that refuses the
upload when HEAD or a tracked file other than pubspec.lock changed during the
build, or when HEAD moved between the start of the run and the build
(--no-drift-check to skip). A git that fails inside a checkout stops the
deploy instead of switching the guard off. Pull, commit and push stay in your
script. --tag application_id/version_code are refused: the file sets them.

Defines: --dart-define KEY=VALUE, or --dart-define KEY to take the value from
the environment (unset or empty is an error). --dart-define-from-file must
exist. Flag defines apply to every --build-profile of the run (per-profile
defines go in ` + ContextFile + ` "build", below); values are never
printed, but a --dart-define value is visible in the process list while
flutter runs, so prefer the file for anything sensitive.

Project defaults: ` + ContextFile + ` "build" next to pubspec.yaml sets requireFlutter, prebuild (a
script inside the project, run once before the first build), create, versionTag,
commit/note ("auto"), noteSkip, and under "android" splitPerAbi, targetPlatform,
versionCodeOffset and per build profile stage, dartDefines (key names only;
values come from the environment) and dartDefineFiles. --prebuild/--no-prebuild
and --require-flutter override the first two; a failing prebuild script stops
the deploy with exit 1 (after a --do-bump has been written). A flag that is given
wins; an unknown or repeated key is an error. --print-config shows the merged
settings and the flutter command lines with define values masked, and exits
without running anything. deploy runs project code (the prebuild script, then
Gradle) with your environment: on a checkout you did not write, use only
--print-config.

--no-upload only builds: no login or team context is needed and the output
paths are printed. Arguments after -- go to "flutter build" unchanged, except
the ones deploy owns (flavor, build mode, split/target platform, defines,
build name/number, Gradle properties) and --verbose, which prints defines.`,
		Example: "  yyt catalog deploy --team dooroo --project-path .\n" +
			"  yyt catalog deploy --build-profile release --build-profile appbundle --stage beta --note \"fix crash\"\n" +
			"  yyt catalog deploy --do-bump --bump minor --split-per-abi --commit \"$(git rev-parse --short HEAD)\" --json\n" +
			"  yyt catalog deploy --variant pro --build-profile debug --split-per-abi --target-platform android-arm64 --dart-define TRACER_DSN --stage debug\n" +
			"  yyt catalog deploy --flavor pro --name sample-pro --application-id com.example.sample.pro --build-profile appbundle\n" +
			"  yyt catalog deploy --variant lite --build-profile debug --no-upload --dart-define-from-file defines.json\n" +
			"  yyt catalog deploy --variant pro --build-profile debug --build-profile release --print-config\n" +
			"  yyt catalog deploy --variant pro --no-create --version-code-offset 2000 --version-tag marketing --commit auto --note auto --note-skip \"^Bump version to \"",
		Annotations: map[string]string{
			OutputAnnotation: "one line per uploaded artifact \"<id> <build_type> [abi] <url>\", progress on stderr; --json: {app,version,commit?,artifacts:[{id,platform,url,tags:{version,version_code,…},…}],verified}. --no-upload: one line per file \"<path> <build_type> [abi]\"; --json: {version,commit?,outputs:[{path,buildType,abi,applicationId,versionCode}]}. --print-config: \"<key>: <value>\" lines, then one \"<profile> (stage \\\"<s>\\\"): flutter build …\" line per profile; --json: {config,platform,version,versionTag,versionCodeOffset?,variant,flavor,app,applicationId,create,commit,note,noteSkip,requireFlutter,prebuild,driftCheck,requireClean,upload,profiles:[{profile,stage,splitPerAbi,targetPlatform,dartDefines,dartDefineFiles,flutter:[argv, define values masked]}]}",
		},
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 && cmd.ArgsLenAtDash() != 0 {
				// Not echoed: after a quoting slip this is a define's value.
				return fmt.Errorf("%d unexpected argument(s) before -- (flutter build arguments go after --; a --dart-define value needs KEY=VALUE)", argsBeforeDash(cmd, args))
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, passthrough []string) error {
			ctx := cmd.Context()
			if len(profiles) == 0 {
				profiles = []string{"release"}
			}
			if len(profiles) == 1 && profiles[0] == "all" {
				profiles = []string{"debug", "release", "appbundle"}
			}
			for i, pr := range profiles {
				profiles[i] = normalizeProfile(pr)
				if _, ok := profileSpecs[profiles[i]]; !ok {
					return fmt.Errorf("invalid --build-profile %q (debug|release|appbundle|aab|all)", pr)
				}
			}
			if err := checkPassthrough(passthrough); err != nil {
				return err
			}

			// Project build defaults (.yyt.json "build"); a flag that was
			// given always wins.
			cfg, cfgPath, err := findBuildConfig(projectPath)
			if err != nil {
				return err
			}
			changed := cmd.Flags().Changed
			var droid platformBuild
			if cfg.Android != nil {
				droid = *cfg.Android
			}
			if !changed("version-tag") {
				for _, v := range []string{cfg.VersionTag, droid.VersionTag} {
					if v != "" {
						versionTag = v
					}
				}
			}
			if !changed("no-create") && cfg.Create != nil {
				noCreate = !*cfg.Create
			}
			if !changed("commit") {
				commit = cfg.Commit
			}
			if !changed("note") {
				changelog = cfg.Note
			}
			if !changed("note-skip") {
				noteSkips = cfg.NoteSkip
			}
			// An empty pattern matches every subject; `--note-skip ""` is how
			// a caller drops the configured list.
			kept := noteSkips[:0:0]
			for _, raw := range noteSkips {
				if raw != "" {
					kept = append(kept, raw)
				}
			}
			noteSkips = kept
			if !changed("require-flutter") {
				requireFlutter = cfg.RequireFlutter
			}
			checkOffset := changed("version-code-offset")
			if !checkOffset && droid.VersionCodeOffset != nil {
				vcOffset, checkOffset = *droid.VersionCodeOffset, true
			}
			if noPrebuild && changed("prebuild") {
				return errors.New("--prebuild and --no-prebuild cannot be combined")
			}
			if noPrebuild {
				prebuild = ""
			} else if !changed("prebuild") {
				prebuild = cfg.Prebuild
			}
			hook, err := hookPath(projectPath, prebuild)
			if err != nil {
				return err
			}
			userTags, err := parseTags(extraTags)
			if err != nil {
				return err
			}
			for _, k := range []string{"application_id", "version_code"} {
				if _, set := userTags[k]; set {
					return fmt.Errorf("--tag %s: deploy sets this tag from the built file", k)
				}
			}

			// Everything that decides which app and which id the build belongs
			// to is settled here, before pubspec is bumped or anything is created.
			variant, preset, err := resolveVariant(projectPath, variant, flavor, !noUpload)
			if err != nil {
				return err
			}
			if flavor, err = mergePreset("--flavor", flavor, preset.Flavor, variant); err != nil {
				return err
			}
			if name, err = mergePreset("--name", name, preset.App, variant); err != nil {
				return err
			}
			if expectedID, err = mergePreset("--application-id", expectedID, preset.ApplicationID, variant); err != nil {
				return err
			}
			if err := checkIdentity(flavor, name, expectedID); err != nil {
				return err
			}
			// One plan per profile: its stage, its defines and the flutter
			// command line. Every define of every profile is resolved here,
			// before anything is bumped or built.
			flagArgs, flagKeys, err := dartDefineArgs(defines, defineFiles, printConfig)
			if err != nil {
				return err
			}
			plans := make([]profilePlan, 0, len(profiles))
			for _, pr := range profiles {
				spec := profileSpecs[pr]
				pb := droid.Profiles[pr]
				plan := profilePlan{Profile: pr, spec: spec, Stage: pb.Stage, TargetPlatform: droid.TargetPlatform}
				if changed("stage") {
					plan.Stage = stage
				}
				split := false
				for _, v := range []*bool{droid.SplitPerAbi, pb.SplitPerAbi} {
					if v != nil {
						split = *v
					}
				}
				if changed("split-per-abi") {
					split = splitPerAbi
				}
				plan.SplitPerAbi = split && spec.kind == "apk"
				if pb.TargetPlatform != nil {
					plan.TargetPlatform = *pb.TargetPlatform
				}
				if changed("target-platform") {
					plan.TargetPlatform = targetPlatform
				}
				cfgFiles := make([]string, 0, len(pb.DartDefineFiles))
				for _, f := range pb.DartDefineFiles {
					// In the config a file is named relative to the project
					// and stays inside it; it exists before the prebuild
					// script runs. A flag may name any file.
					abs, err := insideProject(projectPath, "dartDefineFiles", f)
					if err != nil {
						return fmt.Errorf("%s: build profile %s: %w", cfgPath, pr, err)
					}
					cfgFiles = append(cfgFiles, abs)
				}
				// A key given on the command line replaces the profile's.
				cfgDefines := make([]string, 0, len(pb.DartDefines))
				for _, k := range pb.DartDefines {
					if !slices.Contains(flagKeys, k) {
						cfgDefines = append(cfgDefines, k)
					}
				}
				cfgArgs, cfgKeys, err := dartDefineArgs(cfgDefines, cfgFiles, printConfig)
				if err != nil {
					return fmt.Errorf("%s: build profile %s: %w", cfgPath, pr, err)
				}
				plan.DefineKeys = append(cfgKeys, flagKeys...)
				plan.DefineFiles = append(cfgFiles, defineFiles...)
				plan.args = []string{"build", spec.kind, "--" + spec.mode}
				if plan.SplitPerAbi {
					plan.args = append(plan.args, "--split-per-abi")
				}
				if plan.TargetPlatform != "" {
					plan.args = append(plan.args, "--target-platform", plan.TargetPlatform)
				}
				if flavor != "" {
					plan.args = append(plan.args, "--flavor", flavor)
				}
				plan.args = append(plan.args, cfgArgs...)
				plan.args = append(plan.args, flagArgs...)
				plan.args = append(plan.args, passthrough...)
				plan.Flutter = append([]string{"flutter"}, maskDefines(plan.args)...)
				plans = append(plans, plan)
			}
			if expectedID == "" {
				if flavor == "" {
					// One applicationId in build.gradle: read it. With flavors
					// the first match is some flavor's, so it is never guessed.
					id, err := flutter.ApplicationID(projectPath)
					if err != nil && !noUpload {
						return err
					}
					expectedID = id
				} else if !noUpload {
					return fmt.Errorf("--flavor %s: pass --application-id (the flavor's release applicationId) or use --variant", flavor)
				}
			}
			if name == "" {
				if flavor != "" && !noUpload {
					// The last id segment of a flavor is "pro" or "debug":
					// a default would create a stray app under that name.
					return fmt.Errorf("--flavor %s: pass --name (the catalog app of this flavor) or use --variant", flavor)
				}
				name = expectedID[strings.LastIndex(expectedID, ".")+1:]
			}
			display := name
			if display == "" {
				if abs, err := filepath.Abs(projectPath); err == nil {
					display = filepath.Base(abs)
				}
			}
			if versionTag != "full" && versionTag != "marketing" {
				return fmt.Errorf("invalid --version-tag %q (full|marketing)", versionTag)
			}
			skips := make([]*regexp.Regexp, 0, len(noteSkips))
			for _, raw := range noteSkips {
				re, err := regexp.Compile(raw)
				if err != nil {
					return fmt.Errorf("--note-skip: %w", err)
				}
				skips = append(skips, re)
			}
			if checkOffset && vcOffset < 0 {
				return errors.New("--version-code-offset must not be negative")
			}
			version, err := flutter.Version(projectPath)
			if err != nil {
				return err
			}
			// The bump is computed here and written later, so everything
			// below is checked against the version that will be built.
			bumpFrom := version
			if doBump {
				b, err := flutter.ParseBump(bump)
				if err != nil {
					return err
				}
				if version, err = flutter.BumpVersion(version, b); err != nil {
					return err
				}
			}
			versionName, buildNumber, hasBuild := flutter.SplitVersion(version)
			if checkOffset && !hasBuild {
				return fmt.Errorf("--version-code-offset needs a build number in the pubspec version (x.y.z+n), found %s", version)
			}
			tagVersion := version
			if versionTag == "marketing" {
				tagVersion = versionName
			}

			if printConfig {
				// The merged result, for moving a script over: nothing is
				// read from git or the console, built or written.
				res := map[string]any{
					"config": cfgPath, "platform": "android", "version": version, "versionTag": versionTag,
					"variant": variant, "flavor": flavor, "app": name, "applicationId": expectedID,
					"create": !noCreate, "commit": commit, "note": changelog, "noteSkip": noteSkips,
					"requireFlutter": requireFlutter, "prebuild": prebuild,
					"driftCheck": !noDriftCheck, "requireClean": requireClean, "upload": !noUpload,
					"profiles": plans,
				}
				if checkOffset {
					res["versionCodeOffset"] = vcOffset
				}
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				for _, k := range []string{"config", "version", "versionTag", "versionCodeOffset", "variant", "flavor", "app", "applicationId",
					"create", "commit", "note", "noteSkip", "requireFlutter", "prebuild", "driftCheck", "requireClean", "upload"} {
					if v, ok := res[k]; ok && fmt.Sprint(v) != "" && fmt.Sprint(v) != "[]" {
						fmt.Fprintf(a.Out, "%s: %s\n", k, textsafe.Clean(fmt.Sprint(v)))
					}
				}
				for _, plan := range plans {
					quoted := make([]string, len(plan.Flutter))
					for i, arg := range plan.Flutter {
						quoted[i] = arg
						// One argument stays one visible word.
						if strings.ContainsAny(arg, " \t\r\n\"'") || textsafe.Clean(arg) != arg {
							quoted[i] = strconv.Quote(arg)
						}
					}
					fmt.Fprintf(a.Out, "%s (stage %q): %s\n", plan.Profile, plan.Stage, strings.Join(quoted, " "))
				}
				return nil
			}
			if requireFlutter != "" {
				got, err := flutterVersion(ctx, projectPath)
				if err != nil {
					return err
				}
				if got != requireFlutter {
					return fmt.Errorf("this project requires Flutter %s, the flutter on PATH is %s", requireFlutter, got)
				}
			}

			// Git is only read (docs/decisions.md): the commit and note
			// defaults, and the state the drift guard compares at the end.
			autoNoteWanted := changelog == "auto" && !noUpload
			guard := false
			var start gitState
			if !noDriftCheck || commit == "auto" || autoNoteWanted || requireClean {
				repo, err := inGitRepo(ctx, projectPath)
				if err != nil {
					return fmt.Errorf("cannot read the git repository at %s: %w (the drift guard needs it; --no-drift-check builds without the guard)", projectPath, err)
				}
				if !repo {
					for _, f := range []struct {
						flag   string
						wanted bool
					}{{"--commit auto", commit == "auto"}, {"--note auto", autoNoteWanted}, {"--require-clean", requireClean}} {
						if f.wanted {
							return fmt.Errorf("%s needs a git repository at %s", f.flag, projectPath)
						}
					}
				} else {
					// One snapshot names the commit this run is about: the
					// commit tag, the note and the drift baseline all hang
					// on its HEAD.
					if start, err = gitSnapshot(ctx, projectPath); err != nil {
						return err
					}
					guard = !noDriftCheck
				}
			}
			if requireClean && len(start.changed) > 0 {
				return fmt.Errorf("--require-clean: tracked files are modified: %s", summarize(start.changed))
			}
			if (commit == "auto" || autoNoteWanted) && start.head == "" {
				return errors.New("--commit auto and --note auto need a commit; this repository has none")
			}
			if commit == "auto" {
				if commit, err = git(ctx, projectPath, "rev-parse", "--short", start.head); err != nil {
					return err
				}
			}
			if autoNoteWanted {
				if changelog, err = autoNote(ctx, projectPath, start.head, skips); err != nil {
					return err
				}
			}
			// What can be known about the tools is settled before pubspec is
			// bumped or a build is spent: a wrong AAPT2, or a bundle whose
			// versionCode nothing here can read.
			tools := aapt2Lookup{project: projectPath}
			if _, err := tools.get(ctx); err != nil {
				if !errors.Is(err, android.ErrNoAAPT2) {
					return err
				}
				if tools.broken != nil {
					fmt.Fprintf(a.Err, "note: %v; continuing without aapt2\n", tools.broken)
				}
				for _, pr := range profiles {
					if checkOffset && profileSpecs[pr].kind != "apk" {
						return fmt.Errorf("--version-code-offset on a bundle needs aapt2 to read the versionCode: %w", err)
					}
				}
			}

			// Resolve the context before touching pubspec so a missing context
			// fails without a side effect, and say where the app will land
			// before anything is created.
			var (
				cc   *ctxClient
				cl   *api.Client
				team resolved

				appRow     catalogApp
				appID      string
				appMissing bool
			)
			if noUpload {
				var ignored []string
				for _, n := range []string{"name", "description", "stage", "note", "build", "min-sdk", "target-sdk", "abi", "tag", "no-verify", "version-tag", "no-create", "note-skip"} {
					if cmd.Flags().Changed(n) {
						ignored = append(ignored, "--"+n)
					}
				}
				if len(ignored) > 0 {
					fmt.Fprintf(a.Err, "note: --no-upload ignores %s\n", strings.Join(ignored, ", "))
				}
			} else {
				if cc, err = a.ctxClient(cmd); err != nil {
					return err
				}
				if team, err = cc.scope(ctx, true); err != nil {
					return err
				}
				cl = cc.cl
				fmt.Fprintf(a.Err, "deploying %s to %s\n", name, team)
				// Lookup only: nothing is created until the build is checked.
				if appID, appMissing, err = findDeployApp(ctx, cc, team, name, &appRow); err != nil {
					return err
				}
				if appMissing && noCreate {
					// Before the build: a typo in the name must not cost one.
					return &api.Error{Status: http.StatusNotFound, Code: "not_found",
						Message: fmt.Sprintf("app %q does not exist in %s and --no-create is set", name, team)}
				}
				if flavor != "" && appRow.Path != "" && appRow.Path != expectedID {
					fmt.Fprintf(a.Err, "warning: app %s is registered for %s, this build is %s\n", name, appRow.Path, expectedID)
				}
			}

			if doBump {
				if err := flutter.SetVersion(projectPath, version); err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "bumped version %s -> %s\n", bumpFrom, version)
			}
			if hook != "" {
				// Once per run, after the bump and before the first build;
				// what it generates is part of the drift baseline.
				fmt.Fprintf(a.Err, "running prebuild %s…\n", prebuild)
				if err := deployRunner(ctx, projectPath, hook); err != nil {
					return fmt.Errorf("prebuild %s: %w", prebuild, err)
				}
				// Everything was planned and will be tagged with the version
				// read before the script ran.
				if now, err := flutter.Version(projectPath); err != nil || now != version {
					return fmt.Errorf("prebuild %s changed the pubspec version (%s -> %s): bump before the deploy or with --do-bump", prebuild, version, now)
				}
			}
			// The baseline is taken after the bump, so the bumped pubspec is
			// part of it and only a later change counts as drift. HEAD must
			// still be the commit the tag and the note were read from.
			var baseline gitState
			if guard {
				if baseline, err = gitSnapshot(ctx, projectPath); err != nil {
					return err
				}
				if baseline.head != start.head {
					return fmt.Errorf("HEAD moved from %s to %s before the build started: run again", short(start.head), short(baseline.head))
				}
			}
			checkDrift := func() error {
				if !guard {
					return nil
				}
				now, err := gitSnapshot(ctx, projectPath)
				if err != nil {
					return err
				}
				if d := baseline.drift(now); d != "" {
					return fmt.Errorf("the repository changed while building (%s): the build may not be the commit it would be tagged with, not uploading (--no-drift-check to skip)", d)
				}
				return nil
			}

			// Build every profile and check what was packaged before the
			// console is asked to create or receive anything.
			type builtProfile struct {
				pr    string
				spec  profileSpec
				outs  []buildOutput
				label string
				stage string
			}
			builds := make([]builtProfile, 0, len(profiles))
			for _, plan := range plans {
				pr, spec, split, buildArgs := plan.Profile, plan.spec, plan.SplitPerAbi, plan.args
				if err := cleanBuildOutputs(projectPath, pr, flavor); err != nil {
					return err
				}
				what := pr
				if flavor != "" {
					what += ", flavor " + flavor
				}
				if len(plan.DefineKeys) > 0 {
					what += ", defines " + strings.Join(plan.DefineKeys, " ")
				}
				if len(plan.DefineFiles) > 0 {
					names := make([]string, 0, len(plan.DefineFiles))
					for _, f := range plan.DefineFiles {
						names = append(names, textsafe.Clean(filepath.Base(f)))
					}
					what += ", define files " + strings.Join(names, " ")
				}
				fmt.Fprintf(a.Err, "building %s (%s)…\n", display, what)
				if err := deployRunner(ctx, projectPath, "flutter", buildArgs...); err != nil {
					return fmt.Errorf("flutter build %s: %w", pr, err)
				}
				outs, err := buildOutputs(projectPath, pr, flavor, split)
				if err != nil {
					return err
				}
				for _, out := range outs {
					if _, err := os.Stat(out.path); err != nil {
						return fmt.Errorf("expected build output is missing: %w", err)
					}
				}
				var meta *flutter.BuildMetadata
				if spec.kind == "apk" {
					if meta, err = flutter.BuiltMetadata(projectPath, flavor, spec.mode); err != nil {
						return err
					}
				}
				noted := false
				note := func(msg string) {
					if !noted {
						fmt.Fprintln(a.Err, "note: "+msg)
						noted = true
					}
				}
				for i := range outs {
					info, err := inspectArtifact(ctx, &tools, outs[i], spec.kind, meta)
					if err != nil {
						return err
					}
					switch {
					case info.id == "" && spec.kind == "apk" && flavor != "" && !noUpload:
						// With flavors the id is the only thing that tells
						// the editions apart, so an unchecked upload is refused.
						return fmt.Errorf("no Gradle output metadata (%s) for flavor %s and no aapt2: cannot confirm the application id, not uploading",
							filepath.Join("build", "app", "outputs", "apk", flavor, spec.mode, "output-metadata.json"), flavor)
					case info.id == "" && spec.kind == "apk":
						note("no Gradle output metadata for this build; the application id was not checked")
					case info.id == "":
						note("aapt2 not found; the bundle's application id and versionCode were not checked (set AAPT2 or install Android build-tools)")
					case expectedID != "":
						if err := checkBuiltID(expectedID, info.id, spec.mode); err != nil {
							return err
						}
					}
					if checkOffset {
						if err := checkVersionCode(outs[i], info, vcOffset, buildNumber); err != nil {
							return err
						}
					}
					outs[i].info = info
				}
				bp := builtProfile{pr: pr, spec: spec, outs: outs, stage: plan.Stage,
					label: flutter.Label(projectPath, flavor, spec.mode)}
				builds = append(builds, bp)
			}
			if err := checkDrift(); err != nil {
				return err
			}
			if noUpload {
				var built []builtFile
				for _, bp := range builds {
					for _, out := range bp.outs {
						// Only what was read back from the file, never a guess.
						built = append(built, builtFile{Path: out.path, BuildType: bp.pr, ABI: out.abi,
							ApplicationID: out.info.id, VersionCode: out.info.versionCode})
					}
				}
				if a.jsonOut {
					res := map[string]any{"version": version, "outputs": built}
					if commit != "" {
						res["commit"] = commit
					}
					return a.printer().JSONValue(res)
				}
				for _, b := range built {
					fields := []string{b.Path, b.BuildType}
					if b.ABI != "" {
						fields = append(fields, b.ABI)
					}
					fmt.Fprintln(a.Out, strings.Join(fields, " "))
				}
				return nil
			}

			if appMissing {
				if appID, err = createDeployApp(ctx, a, cc, team, name, expectedID, description, projectPath, &appRow); err != nil {
					return err
				}
			}
			uploaded := make([]catalogArtifact, 0, len(builds))
			for _, bp := range builds {
				for _, out := range bp.outs {
					// Copy (not rename) so the CDN filename carries
					// app+version+profile(+abi) and Flutter's own output stays
					// where `flutter install` and other tools expect it.
					suffix := ""
					if out.abi != "" {
						suffix = "-" + out.abi
					}
					dst := filepath.Join(filepath.Dir(out.path),
						fmt.Sprintf("%s-%s-%s%s%s", name, version, bp.pr, suffix, bp.spec.ext))
					if err := copyFile(out.path, dst); err != nil {
						return err
					}
					id := out.info.id
					if id == "" {
						id = expectedID
					}
					tags := map[string]string{
						"version":        tagVersion,
						"build_type":     bp.pr, // matches the server enum (debug|release|appbundle)
						"application_id": id,
					}
					if out.info.versionCode > 0 {
						tags["version_code"] = strconv.Itoa(out.info.versionCode)
					}
					// What the file says, unless the caller said otherwise.
					addTagIf(tags, "min_sdk", out.info.minSdk)
					addTagIf(tags, "target_sdk", out.info.targetSdk)
					addTagIf(tags, "stage", bp.stage)
					addTagIf(tags, "changelog", changelog)
					addTagIf(tags, "title", bp.label)
					addTagIf(tags, "build", buildNo)
					addTagIf(tags, "commit", commit)
					addTagIf(tags, "min_sdk", minSdk)
					addTagIf(tags, "target_sdk", targetSdk)
					addTagIf(tags, "abi", abiTag)
					if out.abi != "" {
						tags["abi"] = out.abi
					}
					for k, v := range userTags {
						tags[k] = v
					}
					fmt.Fprintf(a.Err, "uploading %s…\n", filepath.Base(dst))
					art, err := uploadArtifact(ctx, cl, appID, dst, "android", tags)
					if err != nil {
						return err
					}
					a.reportVersionLink(art)
					uploaded = append(uploaded, *art)
				}
			}
			verified := 0
			if !noVerify {
				ids := make([]string, 0, len(uploaded))
				for _, art := range uploaded {
					ids = append(ids, art.ID)
				}
				verified, err = verifyUploaded(ctx, cl, appID, ids)
				if err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "verified: %d artifact(s) visible for version %s\n", verified, tagVersion)
			}
			if a.jsonOut {
				res := map[string]any{"app": appRow, "version": tagVersion, "artifacts": uploaded, "verified": verified}
				if commit != "" {
					res["commit"] = commit
				}
				return a.printer().JSONValue(res)
			}
			for _, art := range uploaded {
				fields := []string{art.ID, art.Tags["build_type"]}
				if abi := art.Tags["abi"]; abi != "" {
					fields = append(fields, abi)
				}
				fields = append(fields, art.URL)
				fmt.Fprintln(a.Out, strings.Join(fields, " "))
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "app name (default: last segment of the applicationId; required with --flavor; pass one when that segment looks like an id, e.g. q_game)")
	f.StringVar(&projectPath, "project-path", ".", "Flutter project directory (also where the "+ContextFile+" search starts)")
	f.StringArrayVar(&profiles, "build-profile", nil, "debug|release|appbundle|aab|all (repeatable; default release)")
	f.StringVar(&description, "description", "", "description when creating the app")
	f.StringVar(&stage, "stage", "", "stage tag (e.g. alpha, beta, prod)")
	f.StringVar(&changelog, "note", "", "changelog tag; \"auto\" = the subject of the newest commit no --note-skip matches")
	f.StringArrayVar(&noteSkips, "note-skip", nil, "with --note auto: regexp of commit subjects to walk past (repeatable)")
	f.IntVar(&vcOffset, "version-code-offset", 0, "require the packaged versionCode to be <n> + the pubspec build number (APK: Gradle metadata or aapt2; bundle: aapt2)")
	f.StringVar(&versionTag, "version-tag", "full", "version tag: full (pubspec x.y.z+n) or marketing (x.y.z)")
	f.BoolVar(&noCreate, "no-create", false, "fail (exit 5) before building when the app does not exist, instead of creating it")
	f.BoolVar(&noDriftCheck, "no-drift-check", false, "skip the guard that refuses the upload when HEAD or a tracked file (pubspec.lock aside) changed during the build")
	f.StringVar(&prebuild, "prebuild", "", "script inside the project to run once before the first build (default: "+ContextFile+" build.prebuild)")
	f.BoolVar(&noPrebuild, "no-prebuild", false, "do not run the configured prebuild script")
	f.StringVar(&requireFlutter, "require-flutter", "", "fail unless the flutter on PATH is exactly this version (default: "+ContextFile+" build.requireFlutter)")
	f.BoolVar(&printConfig, "print-config", false, "print the merged build settings and the flutter command lines (define values masked), then exit")
	f.BoolVar(&requireClean, "require-clean", false, "refuse to start when tracked files are modified (pubspec.lock aside)")
	f.StringVar(&bump, "bump", "patch", "version bump when --do-bump: major|minor|patch")
	f.BoolVar(&doBump, "do-bump", false, "bump pubspec version before building")
	f.BoolVar(&splitPerAbi, "split-per-abi", false, "pass --split-per-abi to flutter build (APK profiles; uploads one artifact per ABI)")
	f.StringVar(&targetPlatform, "target-platform", "", "pass --target-platform to flutter build (e.g. android-arm64)")
	f.StringVar(&flavor, "flavor", "", "pass --flavor to flutter build (Gradle product flavor)")
	f.StringVar(&variant, "variant", "", "variant preset from "+ContextFile+" \"variants\": sets --flavor, --name and --application-id")
	f.StringVar(&expectedID, "application-id", "", "expected release applicationId (default: read from build.gradle; required with --flavor)")
	f.StringArrayVar(&defines, "dart-define", nil, "KEY=VALUE, or KEY to read the value from the environment (repeatable)")
	f.StringArrayVar(&defineFiles, "dart-define-from-file", nil, "pass --dart-define-from-file to flutter build; the file must exist (repeatable)")
	f.BoolVar(&noUpload, "no-upload", false, "build only: no login, no upload; print the output paths")
	f.StringVar(&buildNo, "build", "", "build tag (build number)")
	f.StringVar(&commit, "commit", "", "commit tag; \"auto\" = git rev-parse --short HEAD")
	f.StringVar(&minSdk, "min-sdk", "", "min_sdk tag (default: read from the built file when aapt2 is installed)")
	f.StringVar(&targetSdk, "target-sdk", "", "target_sdk tag (default: read from the built file when aapt2 is installed)")
	f.StringVar(&abiTag, "abi", "", "abi tag (overridden per file when --split-per-abi)")
	f.StringArrayVar(&extraTags, "tag", nil, "extra tag key=value (repeatable; server allowlist applies)")
	f.BoolVar(&noVerify, "no-verify", false, "skip the post-upload artifact list verification")
	return c
}

// findDeployApp looks the catalog app up by name before the build. missing
// means it has to be created; an app of that name elsewhere in the team is an
// error here, so a long build is not spent on a deploy that cannot land.
func findDeployApp(ctx context.Context, cc *ctxClient, team resolved, name string, appRow *catalogApp) (appID string, missing bool, err error) {
	appID, err = cc.app(ctx, name, true)
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.Status == 404 {
		// With a project context the lookup was narrowed; an app of that
		// name in another project of the team would make the create a 409,
		// so say where it lives instead.
		if team.ProjectID != "" {
			rows, err := cc.teamApps(ctx, team.TeamID)
			if err != nil {
				return "", false, err
			}
			for _, row := range rows {
				if strings.EqualFold(row.Name, name) && row.ProjectID != team.ProjectID {
					return "", false, fmt.Errorf("app %q already exists in team %s under project %s, not %s: drop --project or pass --project %s", name, team.TeamName, row.ProjectID, team.ProjectName, row.ProjectID)
				}
			}
		}
		return "", true, nil
	}
	if err != nil {
		return "", false, err
	}
	if err := cc.cl.Do(ctx, http.MethodGet, "/catalog/apps/"+api.PathID(appID), nil, appRow); err != nil {
		return "", false, err
	}
	return appID, false, nil
}

// createDeployApp creates the app in the project context, else in the project
// named after the project directory (created when missing). It runs after the
// build, once the packaged id is known to be the expected one.
func createDeployApp(ctx context.Context, a *App, cc *ctxClient, team resolved, name, applicationID, description, projectPath string, appRow *catalogApp) (string, error) {
	abs, err := filepath.Abs(projectPath)
	if err != nil {
		return "", err
	}
	r, created, err := cc.projectIn(ctx, team, filepath.Base(abs))
	if created {
		fmt.Fprintf(a.Err, "created project %s (%s)\n", r.ProjectName, r.ProjectID)
	}
	if err != nil {
		return "", err
	}
	body := map[string]any{"name": name, "path": applicationID}
	if description != "" {
		body["description"] = description
	}
	if err := cc.cl.Do(ctx, http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/catalog/apps", body, appRow); err != nil {
		return "", err
	}
	fmt.Fprintf(a.Err, "created app %s (%s) in %s\n", name, appRow.ID, r)
	return appRow.ID, nil
}

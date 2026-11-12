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
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/flutter"
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
// keys is what may be printed; values never are.
func dartDefineArgs(defines, files []string) (args, keys []string, err error) {
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
and so does a flavored APK without that metadata. The packaged id is what the
application_id tag carries. Bundles (.aab) have no such metadata and are
tagged with the expected id unchecked.

Defines: --dart-define KEY=VALUE, or --dart-define KEY to take the value from
the environment (unset or empty is an error). --dart-define-from-file must
exist. Defines apply to every --build-profile of the run; values are never
printed, but a --dart-define value is visible in the process list while
flutter runs, so prefer the file for anything sensitive.

--no-upload only builds: no login or team context is needed and the output
paths are printed. Arguments after -- go to "flutter build" unchanged, except
the ones deploy owns (flavor, build mode, split/target platform, defines,
build name/number, Gradle properties) and --verbose, which prints defines.`,
		Example: "  yyt catalog deploy --team dooroo --project-path .\n" +
			"  yyt catalog deploy --build-profile release --build-profile appbundle --stage beta --note \"fix crash\"\n" +
			"  yyt catalog deploy --do-bump --bump minor --split-per-abi --commit \"$(git rev-parse --short HEAD)\" --json\n" +
			"  yyt catalog deploy --variant pro --build-profile debug --split-per-abi --target-platform android-arm64 --dart-define TRACER_DSN --stage debug\n" +
			"  yyt catalog deploy --flavor pro --name sample-pro --application-id com.example.sample.pro --build-profile appbundle\n" +
			"  yyt catalog deploy --variant lite --build-profile debug --no-upload --dart-define-from-file defines.json",
		Annotations: map[string]string{
			OutputAnnotation: "one line per uploaded artifact \"<id> <build_type> [abi] <url>\", progress on stderr; --json: {app,version,artifacts:[{id,platform,url,tags,…}],verified}. --no-upload: one line per file \"<path> <build_type> [abi]\"; --json: {version,outputs:[{path,buildType,abi,applicationId}]}",
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
			userTags, err := parseTags(extraTags)
			if err != nil {
				return err
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
			defineArgs, defineKeys, err := dartDefineArgs(defines, defineFiles)
			if err != nil {
				return err
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
			version, err := flutter.Version(projectPath)
			if err != nil {
				return err
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
				for _, n := range []string{"name", "description", "stage", "note", "build", "commit", "min-sdk", "target-sdk", "abi", "tag", "no-verify"} {
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
				if flavor != "" && appRow.Path != "" && appRow.Path != expectedID {
					fmt.Fprintf(a.Err, "warning: app %s is registered for %s, this build is %s\n", name, appRow.Path, expectedID)
				}
			}

			if doBump {
				b, err := flutter.ParseBump(bump)
				if err != nil {
					return err
				}
				next, err := flutter.BumpVersion(version, b)
				if err != nil {
					return err
				}
				if err := flutter.SetVersion(projectPath, next); err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "bumped version %s -> %s\n", version, next)
				version = next
			}

			// Build every profile and check what was packaged before the
			// console is asked to create or receive anything.
			type builtProfile struct {
				pr      string
				spec    profileSpec
				outs    []buildOutput
				id      string // the application_id tag
				checked bool   // id read from Gradle's metadata
				label   string
			}
			builds := make([]builtProfile, 0, len(profiles))
			for _, pr := range profiles {
				spec := profileSpecs[pr]
				split := splitPerAbi && spec.kind == "apk"
				buildArgs := []string{"build", spec.kind, "--" + spec.mode}
				if split {
					buildArgs = append(buildArgs, "--split-per-abi")
				}
				if targetPlatform != "" {
					buildArgs = append(buildArgs, "--target-platform", targetPlatform)
				}
				if flavor != "" {
					buildArgs = append(buildArgs, "--flavor", flavor)
				}
				buildArgs = append(buildArgs, defineArgs...)
				buildArgs = append(buildArgs, passthrough...)
				if err := cleanBuildOutputs(projectPath, pr, flavor); err != nil {
					return err
				}
				what := pr
				if flavor != "" {
					what += ", flavor " + flavor
				}
				if len(defineKeys) > 0 {
					what += ", defines " + strings.Join(defineKeys, " ")
				}
				if len(defineFiles) > 0 {
					what += fmt.Sprintf(", %d define file(s)", len(defineFiles))
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
				bp := builtProfile{pr: pr, spec: spec, outs: outs, id: expectedID,
					label: flutter.Label(projectPath, flavor, spec.mode)}
				if spec.kind == "apk" {
					id, err := flutter.BuiltApplicationID(projectPath, flavor, spec.mode)
					if err != nil {
						return err
					}
					switch {
					case id == "" && flavor != "" && !noUpload:
						// With flavors the id is the only thing that tells
						// the editions apart, so an unchecked upload is refused.
						return fmt.Errorf("no Gradle output metadata (%s) for flavor %s: cannot confirm the application id, not uploading",
							filepath.Join("build", "app", "outputs", "apk", flavor, spec.mode, "output-metadata.json"), flavor)
					case id == "":
						fmt.Fprintln(a.Err, "note: no Gradle output metadata for this build; the application id was not checked")
					default:
						if expectedID != "" {
							if err := checkBuiltID(expectedID, id, spec.mode); err != nil {
								return err
							}
						}
						bp.id, bp.checked = id, true
					}
				}
				builds = append(builds, bp)
			}
			if noUpload {
				var built []builtFile
				for _, bp := range builds {
					for _, out := range bp.outs {
						b := builtFile{Path: out.path, BuildType: bp.pr, ABI: out.abi}
						if bp.checked {
							// Only an id that was read back; a bundle's is a guess.
							b.ApplicationID = bp.id
						}
						built = append(built, b)
					}
				}
				if a.jsonOut {
					return a.printer().JSONValue(map[string]any{"version": version, "outputs": built})
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
					tags := map[string]string{
						"version":        version,
						"build_type":     bp.pr, // matches the server enum (debug|release|appbundle)
						"application_id": bp.id,
					}
					addTagIf(tags, "stage", stage)
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
				fmt.Fprintf(a.Err, "verified: %d artifact(s) visible for version %s\n", verified, version)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{
					"app": appRow, "version": version, "artifacts": uploaded, "verified": verified,
				})
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
	f.StringVar(&changelog, "note", "", "changelog tag")
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
	f.StringVar(&commit, "commit", "", "commit tag (e.g. from 'git rev-parse --short HEAD')")
	f.StringVar(&minSdk, "min-sdk", "", "min_sdk tag")
	f.StringVar(&targetSdk, "target-sdk", "", "target_sdk tag")
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

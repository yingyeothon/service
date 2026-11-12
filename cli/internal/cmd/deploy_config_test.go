package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/api"
)

const sampleBuild = `{"team":"dooroo","project":"game","build":{
 "requireFlutter":"3.47.8","prebuild":"tool/prebuild.sh","create":false,"versionTag":"marketing",
 "commit":"auto","note":"auto","noteSkip":["^Bump version to "],
 "android":{"splitPerAbi":true,"targetPlatform":"android-arm64","versionCodeOffset":2000,
  "profiles":{
   "debug":{"stage":"debug","dartDefines":["SAMPLE_DSN","GIT_SHA"]},
   "release":{"stage":"prod","dartDefines":["SENTRY_KEY"],"dartDefineFiles":["defines/release.json"]},
   "appbundle":{"stage":"prod","splitPerAbi":false}}}}}`

// buildsFromArgs writes the outputs the flutter command line asks for, with
// versionCode 2004 packaged.
func buildsFromArgs(t *testing.T) *[][]string {
	return fakeBuild(t, func(dir string, args []string) error {
		outs := filepath.Join(dir, "build", "app", "outputs")
		mode := strings.TrimPrefix(args[2], "--")
		if args[1] == "appbundle" {
			writeBundle(t, filepath.Join(outs, "bundle", "release", "app-release.aab"))
			return nil
		}
		abi, name := "", "app-"+mode+".apk"
		if strings.Contains(strings.Join(args, " "), "--split-per-abi") {
			abi, name = "arm64-v8a", "app-arm64-v8a-"+mode+".apk"
		}
		id := "life.yyt.demo"
		if mode == "debug" {
			id += ".debug"
		}
		writeFile(t, filepath.Join(outs, "flutter-apk", name), "apk")
		writeFile(t, filepath.Join(outs, "apk", mode, "output-metadata.json"), metadataWithCodes(id, map[string]int{abi: 2004}))
		return nil
	})
}

// writeScript writes an executable file.
func writeScript(t *testing.T, path string) {
	t.Helper()
	writeFile(t, path, "#!/bin/sh\n")
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func configProject(t *testing.T) string {
	t.Helper()
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, ContextFile), sampleBuild)
	writeScript(t, filepath.Join(proj, "tool", "prebuild.sh"))
	writeFile(t, filepath.Join(proj, "defines", "release.json"), "{}")
	return proj
}

// One run builds debug and release from the config: each profile gets its own
// stage and defines, and a debug-only define never reaches the release build.
func TestDeployBuildConfig(t *testing.T) {
	proj := configProject(t)
	calls := buildsFromArgs(t)
	g := fakeGit{repo: true, head: headA, flutter: "3.47.8", log: "Bump version to 1.2.3+4\nReal change\n"}
	fakeTools(t, &g, nil)
	var hooks []string
	fakeHook = func(dir, script string) error {
		if len(*calls) != 0 {
			t.Error("the hook ran after a build")
		}
		hooks = append(hooks, dir+"|"+script)
		return nil
	}
	t.Setenv("SAMPLE_DSN", "s3cret-dsn")
	t.Setenv("GIT_SHA", "abc1234")
	t.Setenv("SENTRY_KEY", "s3cret-key")
	f, committed := deployFake(t)
	_, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj,
		"--build-profile", "debug", "--build-profile", "release", "--dart-define", "EXTRA=1", "--no-verify")
	if err != nil {
		t.Fatal(err)
	}
	// A config file is passed by its resolved path (the temporary directory
	// is a symlink on macOS and a short name on Windows).
	realProj, err := filepath.EvalSymlinks(proj)
	if err != nil {
		t.Fatal(err)
	}
	relFile := filepath.Join(realProj, "defines", "release.json")
	want := []string{
		"build apk --debug --split-per-abi --target-platform android-arm64 --dart-define=SAMPLE_DSN=s3cret-dsn --dart-define=GIT_SHA=abc1234 --dart-define=EXTRA=1",
		"build apk --release --split-per-abi --target-platform android-arm64 --dart-define=SENTRY_KEY=s3cret-key --dart-define-from-file=" + relFile + " --dart-define=EXTRA=1",
	}
	for i, w := range want {
		if got := strings.Join((*calls)[i], " "); got != w {
			t.Fatalf("build %d:\n got %q\nwant %q", i, got, w)
		}
	}
	if len(hooks) != 1 || !strings.HasSuffix(hooks[0], filepath.Join("tool", "prebuild.sh")) || !strings.HasPrefix(hooks[0], proj+"|") {
		t.Fatalf("the hook must run once, from the project root: %v", hooks)
	}
	if len(*committed) != 2 {
		t.Fatalf("uploads: %v", *committed)
	}
	for i, stage := range []string{"debug", "prod"} {
		got := (*committed)[i]
		for k, want := range map[string]string{"stage": stage, "version": "1.2.3", "version_code": "2004", "commit": "1111111", "changelog": "Real change", "abi": "arm64-v8a"} {
			if got[k] != want {
				t.Fatalf("upload %d tag %s = %v, want %s", i, k, got[k], want)
			}
		}
	}
	if strings.Contains(errs, "s3cret") {
		t.Fatalf("a define value reached stderr:\n%s", errs)
	}
}

// A flag that was given wins over the config, for booleans too.
func TestDeployFlagsOverrideBuildConfig(t *testing.T) {
	proj := configProject(t)
	calls := buildsFromArgs(t)
	g := fakeGit{repo: true, head: headA, flutter: "3.50.0"}
	fakeTools(t, &g, nil)
	ran := false
	fakeHook = func(string, string) error { ran = true; return nil }
	t.Setenv("SAMPLE_DSN", "x")
	t.Setenv("GIT_SHA", "y")
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug",
		"--split-per-abi=false", "--target-platform", "android-x64", "--stage", "qa", "--version-tag", "full",
		"--version-code-offset", "2000", "--commit", "deadbee", "--note", "typed", "--no-prebuild",
		"--require-flutter", "3.50.0", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join((*calls)[0], " "); !strings.HasPrefix(got, "build apk --debug --target-platform android-x64 --dart-define=SAMPLE_DSN") {
		t.Fatalf("build args: %q", got)
	}
	for k, want := range map[string]any{"stage": "qa", "version": "1.2.3+4", "commit": "deadbee", "changelog": "typed", "abi": nil} {
		if (*committed)[0][k] != want {
			t.Fatalf("tag %s = %v, want %v", k, (*committed)[0][k], want)
		}
	}
	if ran {
		t.Fatal("--no-prebuild ran the hook")
	}
	// The profile's own splitPerAbi beats the platform default: one bundle.
	f, committed = deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "appbundle",
		"--version-code-offset", "0", "--no-drift-check", "--commit", "x", "--note", "y", "--require-flutter", "3.50.0", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "needs aapt2") {
		t.Fatalf("err = %v", err)
	}
}

// create:false, the config's offset and requireFlutter refuse before a build.
func TestDeployBuildConfigRefusals(t *testing.T) {
	proj := configProject(t)
	calls := buildsFromArgs(t)
	g := fakeGit{repo: true, head: headA, flutter: "3.47.9", log: "Change\n"}
	fakeTools(t, &g, nil)
	hooks := 0
	fakeHook = func(string, string) error { hooks++; return errors.New("exit status 3") }
	t.Setenv("SAMPLE_DSN", "x")
	t.Setenv("GIT_SHA", "y")
	committed := &[]map[string]any{}
	listCalls := 0
	var f *fakeConsole
	routes := deployRoutes(&f, committed, &listCalls, 1)
	routes["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
	f = newFake(t, routes)
	withProject(t)
	base := []string{"catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--no-verify"}
	_, _, err := run(t, f, base...)
	if err == nil || !strings.Contains(err.Error(), "requires Flutter 3.47.8, the flutter on PATH is 3.47.9") || len(f.reqs) != 0 {
		t.Fatalf("err = %v (requests %d)", err, len(f.reqs))
	}
	g.flutter = "3.47.8"
	_, _, err = run(t, f, base...)
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != 404 {
		t.Fatalf("create:false: err = %v", err)
	}
	// --no-create=false lets the flag win; the hook then fails the run.
	_, _, err = run(t, f, append(base, "--no-create=false", "--do-bump")...)
	if err == nil || !strings.Contains(err.Error(), "prebuild tool/prebuild.sh: exit status 3") {
		t.Fatalf("err = %v", err)
	}
	if hooks != 1 || len(*calls) != 0 || len(*committed) != 0 {
		t.Fatalf("hooks %d, builds %d, uploads %d", hooks, len(*calls), len(*committed))
	}
	// The hook ran after the bump.
	if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); !strings.Contains(string(b), "1.2.4+5") {
		t.Fatalf("pubspec: %s", b)
	}
	// A define the profile names but the environment lacks: nothing runs.
	t.Setenv("GIT_SHA", "")
	hooks = 0
	_, _, err = run(t, f, append(base, "--no-create=false")...)
	if err == nil || !strings.Contains(err.Error(), "build profile debug") || !strings.Contains(err.Error(), "GIT_SHA is not set") || hooks != 0 {
		t.Fatalf("err = %v, hooks %d", err, hooks)
	}
	// `catalog bump` never runs the hook.
	if _, _, err := run(t, f, "catalog", "bump", "--project-path", proj); err != nil || hooks != 0 {
		t.Fatalf("bump: %v, hooks %d", err, hooks)
	}
}

// A `build` that cannot be read as written stops deploy before anything.
func TestDeployRefusesBrokenBuildConfig(t *testing.T) {
	for want, build := range map[string]string{
		`unknown field "versionCodeOffest"`:             `{"android":{"versionCodeOffest":2000}}`,
		`unknown field "prebuildd"`:                     `{"prebuildd":"x.sh"}`,
		`unknown field "stage"`:                         `{"stage":"prod"}`,
		"cannot unmarshal":                              `{"android":{"splitPerAbi":"yes"}}`,
		`"note" may only be "auto"`:                     `{"note":"fixed text"}`,
		`"commit" may only be "auto"`:                   `{"commit":"abc"}`,
		"unknown profile":                               `{"android":{"profiles":{"relase":{"stage":"prod"}}}}`,
		"entries are key names":                         `{"android":{"profiles":{"debug":{"dartDefines":["K=v4lue"]}}}}`,
		"versionTag":                                    `{"android":{"versionTag":"short"}}`,
		"must not be negative":                          `{"android":{"versionCodeOffset":-1}}`,
		"\"build\":":                                    `["release"]`,
		"must be a path relative":                       `{"prebuild":"/bin/sh"}`,
		"must stay inside":                              `{"prebuild":"tool/../../x.sh"}`,
		"prebuild \"missing.sh\"":                       `{"prebuild":"missing.sh"}`,
		`the key "PreBuild" must be spelled "prebuild"`: `{"PreBuild":"x.sh"}`,
		`must be spelled "splitPerAbi"`:                 `{"android":{"SPLITPERABI":true}}`,
		`the key "create" appears twice`:                `{"create":false,"create":true}`,
		`the key "stage" appears twice`:                 `{"android":{"profiles":{"debug":{"stage":"a","stage":"b"}}}}`,
		"is the CLI's own environment":                  `{"android":{"profiles":{"debug":{"dartDefines":["YYT_TOKEN"]}}}}`,
		"is listed twice":                               `{"android":{"profiles":{"debug":{"dartDefines":["A","A"]}}}}`,
		"must look like android-arm64":                  `{"android":{"targetPlatform":"android-arm64 --verbose\nprebuild: none"}}`,
		"requireFlutter must be a version":              `{"requireFlutter":"3.47.8\nx"}`,
		"stage has control characters":                  `{"android":{"profiles":{"release":{"stage":"prod\u001b[2K"}}}}`,
		"dartDefineFiles \"../creds.json\"":             `{"android":{"profiles":{"release":{"dartDefineFiles":["../creds.json"]}}}}`,
		"dartDefineFiles \"/etc/hostname\"":             `{"android":{"profiles":{"release":{"dartDefineFiles":["/etc/hostname"]}}}}`,
	} {
		proj := makeFlutterProject(t, "1.2.3+4")
		writeFile(t, filepath.Join(proj, ContextFile), `{"team":"dooroo","build":`+build+`}`)
		calls := fakeBuild(t, func(string, []string) error { return nil })
		f := newFake(t, ctxRoutes(nil, nil, nil, nil))
		withProject(t)
		_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--do-bump")
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: err = %v, want %q", build, err, want)
		}
		if strings.Contains(err.Error(), "v4lue") {
			t.Fatalf("the error echoes a define value: %v", err)
		}
		if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(*calls) != 0 || len(f.reqs) != 0 || !strings.Contains(string(b), "1.2.3+4") {
			t.Fatalf("%s: side effects before the refusal", build)
		}
		// The team in the same file is still read by the context search.
		setHome(t, filepath.Dir(proj))
		if cf, _ := findContextFile(proj); cf.Team != "dooroo" {
			t.Fatalf("team lost: %+v", cf)
		}
	}
}

func TestHookPath(t *testing.T) {
	proj := t.TempDir()
	outside := t.TempDir()
	writeScript(t, filepath.Join(proj, "tool", "pre.sh"))
	writeFile(t, filepath.Join(outside, "evil.sh"), "")
	if got, err := hookPath(proj, "tool/pre.sh"); err != nil || !strings.HasSuffix(got, filepath.Join("tool", "pre.sh")) || !filepath.IsAbs(got) {
		t.Fatalf("%q, %v", got, err)
	}
	if got, err := hookPath(proj, ""); got != "" || err != nil {
		t.Fatalf("no hook: %q, %v", got, err)
	}
	// Every escape target exists, so only the check itself can refuse it.
	sibling := filepath.Base(outside)
	for bad, want := range map[string]string{
		"../" + sibling + "/evil.sh":         "must stay inside",
		"tool/../../" + sibling + "/evil.sh": "must stay inside",
		`tool\..\..\` + sibling + `\evil.sh`: "must stay inside",
		filepath.Join(outside, "evil.sh"):    "must be a path relative",
		`\\host\share\x`:                     "must be a path relative",
		"tool":                               "is not a regular file",
	} {
		if _, err := hookPath(proj, bad); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: err = %v, want %q", bad, err, want)
		}
	}
	if runtime.GOOS == "windows" {
		return // symlinks need a privilege there
	}
	if err := os.Symlink(filepath.Join(outside, "evil.sh"), filepath.Join(proj, "link.sh")); err != nil {
		t.Fatal(err)
	}
	if _, err := hookPath(proj, "link.sh"); err == nil || !strings.Contains(err.Error(), "outside the project") {
		t.Fatalf("a symlink out of the project: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(proj, "dir")); err != nil {
		t.Fatal(err)
	}
	if _, err := hookPath(proj, "dir/evil.sh"); err == nil {
		t.Fatal("a symlinked directory out of the project must be refused")
	}
	if err := os.Symlink(filepath.Join(proj, "tool", "pre.sh"), filepath.Join(proj, "inside.sh")); err != nil {
		t.Fatal(err)
	}
	if _, err := hookPath(proj, "inside.sh"); err != nil {
		t.Fatalf("a symlink that stays inside is fine: %v", err)
	}
	// A world-writable project directory: the build config is not read.
	if err := os.Chmod(proj, 0o777); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(proj, ContextFile), `{"build":{"prebuild":"tool/pre.sh"}}`)
	if _, _, err := findBuildConfig(proj); err == nil || !strings.Contains(err.Error(), "world-writable") {
		t.Fatalf("err = %v", err)
	}
}

// --print-config shows the merged settings and the command lines with the
// define values masked, and touches nothing: no env, git, console or build.
func TestDeployPrintConfig(t *testing.T) {
	proj := configProject(t)
	calls := buildsFromArgs(t)
	hooks := 0
	fakeHook = func(string, string) error { hooks++; return nil }
	f := newFake(t, nil)
	t.Setenv("SAMPLE_DSN", "s3cret-dsn")
	t.Setenv("GIT_SHA", "")
	t.Setenv("SENTRY_KEY", "")
	// Not even a read-only tool: no git, no flutter, no aapt2.
	deployOutput = func(_ context.Context, _, name string, args ...string) ([]byte, error) {
		t.Errorf("--print-config ran %s %v", name, args)
		return nil, errors.New("must not run")
	}
	hasDotGit = func(string) bool { return true }
	out, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "all",
		"--dart-define", "TOKEN=s3cret-token", "--do-bump", "--print-config")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"version: 1.2.4+5", "versionTag: marketing", "versionCodeOffset: 2000", "create: false", "commit: auto", "note: auto",
		"requireFlutter: 3.47.8", "prebuild: tool/prebuild.sh",
		`debug (stage "debug"): flutter build apk --debug --split-per-abi --target-platform android-arm64 --dart-define=SAMPLE_DSN=*** --dart-define=GIT_SHA=<unset> --dart-define=TOKEN=***`,
		`release (stage "prod"): flutter build apk --release --split-per-abi --target-platform android-arm64 --dart-define=SENTRY_KEY=<unset>`,
		`appbundle (stage "prod"): flutter build appbundle --release --target-platform android-arm64 --dart-define=TOKEN=***`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out+errs, "s3cret") {
		t.Fatalf("a define value was printed:\n%s%s", out, errs)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(*calls) != 0 || hooks != 0 || len(f.reqs) != 0 || !strings.Contains(string(b), "1.2.3+4") {
		t.Fatal("--print-config had a side effect")
	}
	out, _, err = run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--print-config", "--json")
	if err != nil || !strings.Contains(out, `"--dart-define=SAMPLE_DSN=***"`) || !strings.Contains(out, `"versionCodeOffset": 2000`) || strings.Contains(out, "s3cret") {
		t.Fatalf("--json: %v\n%s", err, out)
	}
}

// What the reviews of the build config found: each of these once passed.
func TestBuildConfigHardening(t *testing.T) {
	// A second "build" key, and a file that cannot be read, are errors.
	proj := makeFlutterProject(t, "1.2.3+4")
	cfgFile := filepath.Join(proj, ContextFile)
	writeFile(t, cfgFile, `{"build":{"create":false},"build":null}`)
	if _, _, err := findBuildConfig(proj); err == nil || !strings.Contains(err.Error(), `"build" appears twice`) {
		t.Fatalf("err = %v", err)
	}
	// An unknown top-level key given twice is not this command's to judge.
	writeFile(t, cfgFile, `{"x":1,"x":2,"build":{"create":false}}`)
	if cfg, p, err := findBuildConfig(proj); err != nil || p == "" || cfg.Create == nil || *cfg.Create {
		t.Fatalf("%+v %q %v", cfg, p, err)
	}
	if err := os.Remove(cfgFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(cfgFile, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := findBuildConfig(proj); err == nil {
		t.Fatal("a .yyt.json that cannot be read must not read as no config")
	}
	_ = os.Remove(cfgFile)
	if _, p, err := findBuildConfig(proj); err != nil || p != "" {
		t.Fatalf("no file: %q, %v", p, err)
	}

	// flutter prints banners around the JSON.
	g := fakeGit{}
	fakeBuild(t, func(string, []string) error { return nil })
	fakeTools(t, &g, nil)
	for _, out := range []string{
		`{"frameworkVersion":"3.1.0"}` + "\n\nA new version of Flutter is available! {see}\n",
		"Welcome {to} Flutter\n" + `{"channel":"stable","frameworkVersion":"3.1.0"}`,
	} {
		deployOutput = func(context.Context, string, string, ...string) ([]byte, error) { return []byte(out), nil }
		if v, err := flutterVersion(context.Background(), proj); err != nil || v != "3.1.0" {
			t.Fatalf("%q: %q, %v", out, v, err)
		}
	}
	deployOutput = func(context.Context, string, string, ...string) ([]byte, error) { return []byte("{}"), nil }
	if _, err := flutterVersion(context.Background(), proj); err == nil {
		t.Fatal("no frameworkVersion must be an error")
	}

	if runtime.GOOS == "windows" {
		return
	}
	// The script must be runnable now, and not writable by everyone.
	writeFile(t, filepath.Join(proj, "tool", "plain.sh"), "#!/bin/sh\n")
	if _, err := hookPath(proj, "tool/plain.sh"); err == nil || !strings.Contains(err.Error(), "not executable") {
		t.Fatalf("err = %v", err)
	}
	writeScript(t, filepath.Join(proj, "tool", "open.sh"))
	_ = os.Chmod(filepath.Join(proj, "tool", "open.sh"), 0o777)
	if _, err := hookPath(proj, "tool/open.sh"); err == nil || !strings.Contains(err.Error(), "world-writable") {
		t.Fatalf("err = %v", err)
	}
	writeScript(t, filepath.Join(proj, "shared", "ok.sh"))
	_ = os.Chmod(filepath.Join(proj, "shared"), 0o777)
	if _, err := hookPath(proj, "shared/ok.sh"); err == nil || !strings.Contains(err.Error(), "world-writable") {
		t.Fatalf("err = %v", err)
	}
	// A world-writable project directory: a broken file is skipped as
	// everywhere else, a readable build config is refused.
	_ = os.Chmod(proj, 0o777)
	writeFile(t, cfgFile, `{not json`)
	if _, p, err := findBuildConfig(proj); err != nil || p != "" {
		t.Fatalf("a planted broken file must not block deploys: %q, %v", p, err)
	}
}

// A hook that changes the pubspec version is refused; a profile can clear the
// platform's target platform; a flag's define key replaces the profile's;
// `--note-skip ""` drops the configured list.
func TestDeployBuildConfigEdges(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeScript(t, filepath.Join(proj, "pre.sh"))
	writeFile(t, filepath.Join(proj, ContextFile), `{"build":{"prebuild":"pre.sh","note":"auto","noteSkip":["^Top"],
	 "android":{"targetPlatform":"android-arm64","profiles":{
	  "debug":{"dartDefines":["DBG"]},
	  "appbundle":{"targetPlatform":""}}}}}`)
	calls := buildsFromArgs(t)
	g := fakeGit{repo: true, head: headA, log: "Top subject\nOlder\n"}
	fakeTools(t, &g, nil)
	t.Setenv("DBG", "from-env")
	out, _, err := run(t, newFake(t, nil), "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--build-profile", "aab",
		"--dart-define", "DBG=from-flag", "--print-config", "--json")
	if err != nil {
		t.Fatal(err)
	}
	// One DBG per profile (the flag's reaches both), not two in debug.
	if strings.Count(out, "--dart-define=DBG=") != 2 || !strings.Contains(out, `"profile": "appbundle"`) ||
		strings.Count(out, `"--target-platform"`) != 1 {
		t.Fatalf("the flag's key must replace the profile's, and the bundle has no target platform:\n%s", out)
	}
	fakeHook = func(dir, _ string) error {
		return os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: demo\nversion: 9.9.9+99\n"), 0o644)
	}
	f, committed := deployFake(t)
	_, _, err = run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--no-verify")
	if err == nil || !strings.Contains(err.Error(), "changed the pubspec version (1.2.3+4 -> 9.9.9+99)") || len(*calls) != 0 || len(*committed) != 0 {
		t.Fatalf("err = %v, builds %d", err, len(*calls))
	}
	writeFile(t, filepath.Join(proj, "pubspec.yaml"), "name: demo\nversion: 1.2.3+4\n")
	fakeHook = func(string, string) error { return nil }
	f, committed = deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--note-skip", "", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if (*committed)[0]["changelog"] != "Top subject" {
		t.Fatalf("changelog = %v", (*committed)[0]["changelog"])
	}
	if got := strings.Join((*calls)[0], " "); !strings.HasSuffix(got, "--dart-define=DBG=from-env") {
		t.Fatalf("build args: %q", got)
	}
}

// The merge order, one row per step: default < build < build.android <
// profiles.<p> < flag. Each row reads the merged result from --print-config.
func TestBuildConfigPrecedence(t *testing.T) {
	const cfg = `{"build":{"versionTag":"marketing","prebuild":"a.sh","noteSkip":["^cfg"],"note":"auto","requireFlutter":"3.47.8",
	 "android":{"versionTag":"full","splitPerAbi":true,"targetPlatform":"android-arm64","versionCodeOffset":2000,
	  "profiles":{"debug":{"stage":"debug"},"release":{"stage":"prod","splitPerAbi":false,"targetPlatform":"android-arm"}}}}}`
	type plan struct {
		Profile, Stage, TargetPlatform string
		SplitPerAbi                    bool
	}
	type merged struct {
		VersionTag, Prebuild, RequireFlutter, Note string
		VersionCodeOffset                          int
		NoteSkip                                   []string
		Profiles                                   []plan
	}
	read := func(t *testing.T, args ...string) merged {
		t.Helper()
		proj := makeFlutterProject(t, "1.2.3+4")
		writeFile(t, filepath.Join(proj, ContextFile), cfg)
		writeScript(t, filepath.Join(proj, "a.sh"))
		writeScript(t, filepath.Join(proj, "b.sh"))
		fakeBuild(t, func(string, []string) error { return nil })
		out, _, err := run(t, newFake(t, nil), append([]string{"catalog", "deploy", "--project-path", proj,
			"--build-profile", "debug", "--build-profile", "release", "--print-config", "--json"}, args...)...)
		if err != nil {
			t.Fatal(err)
		}
		var m merged
		if err := json.Unmarshal([]byte(out), &m); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		return m
	}
	m := read(t)
	// build.android.versionTag beats build.versionTag; a profile beats the platform.
	if m.VersionTag != "full" || m.Prebuild != "a.sh" || m.VersionCodeOffset != 2000 || strings.Join(m.NoteSkip, "|") != "^cfg" {
		t.Fatalf("config: %+v", m)
	}
	if want := []plan{{"debug", "debug", "android-arm64", true}, {"release", "prod", "android-arm", false}}; fmt.Sprint(m.Profiles) != fmt.Sprint(want) {
		t.Fatalf("profiles: %+v", m.Profiles)
	}
	// Every flag beats the config, on every profile of the run.
	m = read(t, "--version-tag", "marketing", "--prebuild", "b.sh", "--version-code-offset", "7", "--note-skip", "^flag",
		"--stage", "qa", "--split-per-abi", "--target-platform", "android-x64", "--require-flutter", "9.9.9", "--note", "typed")
	if m.VersionTag != "marketing" || m.Prebuild != "b.sh" || m.VersionCodeOffset != 7 || strings.Join(m.NoteSkip, "|") != "^flag" ||
		m.RequireFlutter != "9.9.9" || m.Note != "typed" {
		t.Fatalf("flags: %+v", m)
	}
	if want := []plan{{"debug", "qa", "android-x64", true}, {"release", "qa", "android-x64", true}}; fmt.Sprint(m.Profiles) != fmt.Sprint(want) {
		t.Fatalf("flag profiles: %+v", m.Profiles)
	}
	if m = read(t, "--split-per-abi=false", "--no-prebuild"); m.Profiles[0].SplitPerAbi || m.Prebuild != "" {
		t.Fatalf("=false and --no-prebuild: %+v", m)
	}
	proj := makeFlutterProject(t, "1.2.3+4")
	writeScript(t, filepath.Join(proj, "b.sh"))
	fakeBuild(t, func(string, []string) error { return nil })
	if _, _, err := run(t, newFake(t, nil), "catalog", "deploy", "--project-path", proj, "--prebuild", "b.sh", "--no-prebuild", "--print-config"); err == nil ||
		!strings.Contains(err.Error(), "cannot be combined") {
		t.Fatalf("err = %v", err)
	}
}

// requireFlutter is exact, and a flutter that cannot answer is a refusal.
func TestDeployRequireFlutterIsExact(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsFromArgs(t)
	g := fakeGit{}
	fakeTools(t, &g, nil)
	f, _ := deployFake(t)
	for _, have := range []string{"3.47.80", "3.47", "3.47.8-pre", ""} {
		g.flutter = have
		_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--require-flutter", "3.47.8", "--do-bump", "--no-verify")
		if err == nil || (!strings.Contains(err.Error(), "requires Flutter 3.47.8") && !strings.Contains(err.Error(), "flutter --version")) {
			t.Fatalf("flutter %q: err = %v", have, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(*calls) != 0 || len(f.reqs) != 0 || !strings.Contains(string(b), "1.2.3+4") {
		t.Fatal("side effects before the refusal")
	}
}

// What the hook changes in tracked files is part of the drift baseline.
func TestDeployHookRunsBeforeTheBaseline(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeScript(t, filepath.Join(proj, "gen.sh"))
	buildsFromArgs(t)
	g := fakeGit{repo: true, head: headA}
	fakeTools(t, &g, nil)
	fakeHook = func(string, string) error {
		g.status, g.diff = " M lib/generated.dart\n", "generated"
		return nil
	}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--prebuild", "gen.sh", "--require-clean", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if len(*committed) != 1 {
		t.Fatalf("uploads: %v", *committed)
	}
}

// The real runner: the script starts in the project root with the caller's
// environment, and its stdout goes to stderr so --json stays parseable.
func TestExecRunnerRunsAHook(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a #! script is not executable on Windows")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "pre.sh")
	writeFile(t, script, "#!/bin/sh\npwd > where.txt\nprintf '%s' \"$HOOK_PROBE\" > env.txt\nexit \"$HOOK_EXIT\"\n")
	_ = os.Chmod(script, 0o755)
	t.Setenv("HOOK_PROBE", "passed through")
	t.Setenv("HOOK_EXIT", "0")
	if err := execRunner(context.Background(), dir, script); err != nil {
		t.Fatal(err)
	}
	where, _ := os.ReadFile(filepath.Join(dir, "where.txt"))
	env, _ := os.ReadFile(filepath.Join(dir, "env.txt"))
	real, _ := filepath.EvalSymlinks(dir)
	if got, _ := filepath.EvalSymlinks(strings.TrimSpace(string(where))); got != real || string(env) != "passed through" {
		t.Fatalf("cwd %q, env %q", where, env)
	}
	t.Setenv("HOOK_EXIT", "3")
	if err := execRunner(context.Background(), dir, script); err == nil || !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("err = %v", err)
	}
}

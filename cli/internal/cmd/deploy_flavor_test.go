package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleVariants = `{"team":"dooroo","project":"game","variants":{
 "lite":{"flavor":"lite","app":"demo-lite","applicationId":"com.example.sample"},
 "byid":{"flavor":"pro","app":"ca_1","applicationId":"com.example.sample.pro"},
 "pro":{"flavor":"pro","app":"demo","applicationId":"com.example.sample.pro"}}}`

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func metadataJSON(id string) string {
	return fmt.Sprintf(`{"version":3,"applicationId":%q,"elements":[]}`, id)
}

// A variant preset supplies flavor, app and id; the split APK of that flavor
// is the only file uploaded, tagged with the id Gradle packaged.
func TestDeployVariantSplitApk(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, ContextFile), sampleVariants)
	outs := filepath.Join(proj, "build", "app", "outputs")
	// Leftovers: the other flavor's split APK, a flavorless one, and this
	// flavor's metadata from an earlier build under another id.
	writeFile(t, filepath.Join(outs, "flutter-apk", "app-arm64-v8a-lite-debug.apk"), "lite")
	writeFile(t, filepath.Join(outs, "flutter-apk", "app-arm64-v8a-debug.apk"), "plain")
	staleMeta := filepath.Join(outs, "apk", "pro", "debug", "output-metadata.json")
	writeFile(t, staleMeta, metadataJSON("com.example.other"))
	writeFile(t, filepath.Join(proj, "android", "app", "src", "proDebug", "res", "values", "strings.xml"),
		`<resources><string name="app_name">[D] Sample Pro</string></resources>`)
	writeFile(t, filepath.Join(proj, "android", "app", "src", "pro", "res", "values", "strings.xml"),
		`<resources><string name="app_name">Sample Pro</string></resources>`)

	calls := fakeBuild(t, func(dir string, _ []string) error {
		if _, err := os.Stat(staleMeta); err == nil {
			return fmt.Errorf("stale output metadata survived the clean")
		}
		writeFile(t, filepath.Join(outs, "flutter-apk", "app-arm64-v8a-pro-debug.apk"), "pro")
		writeFile(t, staleMeta, metadataJSON("com.example.sample.pro.debug"))
		return nil
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, &committed, &listCalls, 1))
	t.Setenv("SAMPLE_DSN", "s3cret-dsn")
	_, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj,
		"--variant", "pro", "--build-profile", "debug", "--split-per-abi", "--target-platform", "android-arm64",
		"--dart-define", "GIT_SHA=v4lue", "--dart-define", "SAMPLE_DSN", "--no-verify")
	if err != nil {
		t.Fatal(err)
	}
	want := "build apk --debug --split-per-abi --target-platform android-arm64 --flavor pro --dart-define=GIT_SHA=v4lue --dart-define=SAMPLE_DSN=s3cret-dsn"
	if got := strings.Join((*calls)[0], " "); got != want {
		t.Fatalf("build args:\n got %q\nwant %q", got, want)
	}
	if len(committed) != 1 {
		t.Fatalf("expected 1 upload, got %d: %v", len(committed), committed)
	}
	for k, want := range map[string]string{
		"abi": "arm64-v8a", "application_id": "com.example.sample.pro.debug",
		"build_type": "debug", "title": "[D] Sample Pro",
	} {
		if committed[0][k] != want {
			t.Fatalf("tag %s = %v (want %s)", k, committed[0][k], want)
		}
	}
	if strings.Contains(errs, "s3cret-dsn") || strings.Contains(errs, "v4lue") {
		t.Fatalf("define values leaked to stderr:\n%s", errs)
	}
	if !strings.Contains(errs, "defines GIT_SHA SAMPLE_DSN") || !strings.Contains(errs, "flavor pro") {
		t.Fatalf("stderr must name flavor and define keys:\n%s", errs)
	}
}

// A flavored bundle is found under Gradle's mixed-case variant directory.
func TestDeployFlavorAab(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := fakeBuild(t, func(dir string, _ []string) error {
		writeFile(t, filepath.Join(dir, "build", "app", "outputs", "bundle", "proRelease", "app-pro-release.aab"), "aab")
		// another flavor's bundle must not be picked up
		writeFile(t, filepath.Join(dir, "build", "app", "outputs", "bundle", "liteRelease", "app-lite-release.aab"), "aab")
		return nil
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, &committed, &listCalls, 1))
	withProject(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "pro", "--name", "demo",
		"--application-id", "com.example.sample.pro", "--build-profile", "aab", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join((*calls)[0], " "); got != "build appbundle --release --flavor pro" {
		t.Fatalf("build args: %q", got)
	}
	if len(committed) != 1 || committed[0]["application_id"] != "com.example.sample.pro" || committed[0]["build_type"] != "appbundle" {
		t.Fatalf("uploads: %v", committed)
	}
}

// Variant ids nest. The pro build must not pass as the base app's, in either
// build mode, and nothing may be uploaded.
func TestDeployRefusesNestedApplicationIdMixUp(t *testing.T) {
	for _, mode := range []string{"debug", "release"} {
		t.Run(mode, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			built := "com.example.sample.pro"
			if mode == "debug" {
				built += ".debug"
			}
			fakeBuild(t, func(dir string, _ []string) error {
				outs := filepath.Join(dir, "build", "app", "outputs")
				writeFile(t, filepath.Join(outs, "flutter-apk", "app-lite-"+mode+".apk"), "apk")
				writeFile(t, filepath.Join(outs, "apk", "lite", mode, "output-metadata.json"), metadataJSON(built))
				return nil
			})
			var committed []map[string]any
			listCalls := 0
			var f *fakeConsole
			f = newFake(t, deployRoutes(&f, &committed, &listCalls, 1))
			withProject(t)
			_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "lite", "--name", "demo",
				"--application-id", "com.example.sample", "--build-profile", mode, "--no-verify")
			if err == nil || !strings.Contains(err.Error(), "does not match the expected") {
				t.Fatalf("err = %v, want an application id mismatch", err)
			}
			if len(committed) != 0 {
				t.Fatalf("uploaded despite the mismatch: %v", committed)
			}
		})
	}
}

// A flavored APK whose packaged id cannot be read is not uploaded.
func TestDeployFlavorWithoutMetadataIsNotUploaded(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	fakeBuild(t, func(dir string, _ []string) error {
		writeFile(t, filepath.Join(dir, "build", "app", "outputs", "flutter-apk", "app-pro-release.apk"), "apk")
		return nil
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, &committed, &listCalls, 1))
	withProject(t)
	_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "pro", "--name", "demo",
		"--application-id", "com.example.sample.pro", "--no-verify")
	if err == nil || !strings.Contains(err.Error(), "cannot confirm the application id") {
		t.Fatalf("err = %v, want a refusal", err)
	}
	if len(committed) != 0 {
		t.Fatalf("uploaded without a checked id: %v", committed)
	}
}

func TestCheckBuiltID(t *testing.T) {
	for _, c := range []struct {
		expected, built, mode string
		ok                    bool
	}{
		{"com.example.sample", "com.example.sample", "release", true},
		{"com.example.sample", "com.example.sample", "debug", true},
		{"com.example.sample", "com.example.sample.debug", "debug", true},
		{"com.example.sample", "com.example.sample.debug", "release", false},
		{"com.example.sample", "com.example.sample.pro.debug", "debug", false},
		{"com.example.sample", "com.example.sample.pro", "debug", false},
		{"com.example.sample", "com.example.sample.dev", "debug", false},
		{"com.example.sample", "com.example.sample.", "debug", false},
		{"com.example.sample", "com.example.samplepro", "debug", false},
		{"com.example.sample.pro", "com.example.sample", "debug", false},
	} {
		if err := checkBuiltID(c.expected, c.built, c.mode); (err == nil) != c.ok {
			t.Errorf("checkBuiltID(%q, %q, %s) = %v, want ok=%v", c.expected, c.built, c.mode, err, c.ok)
		}
	}
}

// Everything that picks the app, the id or the build inputs is refused before
// pubspec is bumped, flutter runs or the console is called.
func TestDeployValidatesBeforeAnySideEffect(t *testing.T) {
	cases := []struct {
		name     string
		variants bool
		args     []string
		want     string
	}{
		{"variants declared, none chosen", true, nil, "declares variants (byid, lite, pro): pass --variant"},
		{"unknown variant", true, []string{"--variant", "max"}, "--variant max is not in"},
		{"variant without presets", false, []string{"--variant", "pro"}, "has no \"variants\""},
		{"flag disagrees with preset", true, []string{"--variant", "pro", "--flavor", "lite"}, "--flavor lite disagrees with variant pro"},
		{"flavor without id", false, []string{"--flavor", "pro", "--name", "demo"}, "pass --application-id"},
		{"flavor without name", false, []string{"--flavor", "pro", "--application-id", "com.example.sample.pro"}, "pass --name"},
		{"define not in env", false, []string{"--dart-define", "SAMPLE_UNSET_KEY"}, "SAMPLE_UNSET_KEY is not set"},
		{"define key not a name", false, []string{"--dart-define", "a-b"}, "--dart-define #1"},
		{"define without key", false, []string{"--dart-define", "=x"}, "--dart-define #1"},
		{"define value where the key goes", false, []string{"--dart-define", "K=v", "--dart-define", "https://s3cret@host/1?a=b"}, "--dart-define #2"},
		{"define value as a stray argument", false, []string{"--dart-define", "K", "s3cret"}, "1 unexpected argument(s)"},
		{"flavor with a path", false, []string{"--flavor", "../x", "--name", "demo", "--application-id", "com.example.sample"}, "invalid flavor"},
		{"flavor that is a flag", true, []string{"--flavor", "--obfuscate", "--name", "demo", "--application-id", "com.example.sample"}, "invalid flavor"},
		{"app name with a path", false, []string{"--name", "../demo"}, "invalid app name"},
		{"application id", false, []string{"--application-id", "sample"}, "invalid application id"},
		{"gradle property passthrough", false, []string{"--", "-Ptarget-platform=android-arm"}, "-P cannot be passed after --"},
		{"verbose passthrough", false, []string{"--", "-v"}, "-v cannot be passed after --"},
		{"define file missing", false, []string{"--dart-define-from-file", "no-such-defines.json"}, "--dart-define-from-file"},
		{"reserved passthrough", false, []string{"--", "--flavor=pro"}, "--flavor cannot be passed after --"},
		{"reserved passthrough, split form", false, []string{"--", "--build-number", "9"}, "--build-number cannot be passed after --"},
		{"positional argument", false, []string{"extra"}, "unexpected argument"},
		{"bare flavor of a preset, other app", true, []string{"--flavor", "lite", "--name", "demo"}, "--name demo disagrees with variant lite"},
		{"empty define value", false, []string{"--dart-define", "K="}, "the value is empty"},
		{"preset app is an id", true, []string{"--variant", "byid"}, "must be an app name, not an id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			if c.variants {
				writeFile(t, filepath.Join(proj, ContextFile), sampleVariants)
			}
			calls := fakeBuild(t, func(string, []string) error { return nil })
			f := newFake(t, ctxRoutes(nil, nil, nil, nil))
			withProject(t)
			args := append([]string{"catalog", "deploy", "--project-path", proj, "--do-bump"}, c.args...)
			_, _, err := run(t, f, args...)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if strings.Contains(err.Error(), "s3cret") {
				t.Fatalf("the error echoes a define value: %v", err)
			}
			if len(*calls) != 0 || len(f.reqs) != 0 {
				t.Fatalf("side effects before the refusal: %d build(s), %d request(s)", len(*calls), len(f.reqs))
			}
			if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); !strings.Contains(string(b), "1.2.3+4") {
				t.Fatalf("pubspec was bumped before the refusal:\n%s", b)
			}
		})
	}
}

// --no-upload builds and prints paths without a single console request, and
// needs neither a context nor an id.
func TestDeployNoUpload(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	defs := filepath.Join(t.TempDir(), "defines.json")
	writeFile(t, defs, `{}`)
	calls := fakeBuild(t, func(dir string, _ []string) error {
		outs := filepath.Join(dir, "build", "app", "outputs")
		writeFile(t, filepath.Join(outs, "flutter-apk", "app-pro-debug.apk"), "apk")
		writeFile(t, filepath.Join(outs, "apk", "pro", "debug", "output-metadata.json"), metadataJSON("com.example.sample.pro.debug"))
		return nil
	})
	f := newFake(t, nil)
	out, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "pro",
		"--build-profile", "debug", "--no-upload", "--dart-define-from-file", defs, "--json",
		"--", "--target", "lib/main_dev.dart")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 0 {
		t.Fatalf("--no-upload called the console: %v", f.reqs)
	}
	want := "build apk --debug --flavor pro --dart-define-from-file=" + defs + " --target lib/main_dev.dart"
	if got := strings.Join((*calls)[0], " "); got != want {
		t.Fatalf("build args:\n got %q\nwant %q", got, want)
	}
	for _, want := range []string{"app-pro-debug.apk", `"buildType": "debug"`, `"applicationId": "com.example.sample.pro.debug"`, `"version": "1.2.3+4"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("output lacks %s:\n%s", want, out)
		}
	}
	_, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "pro",
		"--build-profile", "debug", "--no-upload", "--stage", "beta", "--no-verify")
	if err != nil || !strings.Contains(errs, "--no-upload ignores --stage, --no-verify") {
		t.Fatalf("err=%v stderr:\n%s", err, errs)
	}
	// A build that left no file is an error, not an empty success.
	fakeBuild(t, func(string, []string) error { return nil })
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--flavor", "lite", "--no-upload"); err == nil ||
		!strings.Contains(err.Error(), "missing") {
		t.Fatalf("err = %v, want a missing output error", err)
	}
}

// A flavorless split build no longer takes flavored APKs for its own.
func TestBuildOutputsIgnoresOtherFlavors(t *testing.T) {
	proj := t.TempDir()
	apks := filepath.Join(proj, "build", "app", "outputs", "flutter-apk")
	writeFile(t, filepath.Join(apks, "app-arm64-v8a-release.apk"), "a")
	writeFile(t, filepath.Join(apks, "app-arm64-v8a-pro-release.apk"), "b")
	writeFile(t, filepath.Join(apks, "app-pro-release.apk"), "c")
	outs, err := buildOutputs(proj, "release", "", true)
	if err != nil || len(outs) != 1 || outs[0].abi != "arm64-v8a" || filepath.Base(outs[0].path) != "app-arm64-v8a-release.apk" {
		t.Fatalf("flavorless: %+v %v", outs, err)
	}
	outs, err = buildOutputs(proj, "release", "Pro", true)
	if err != nil || len(outs) != 1 || filepath.Base(outs[0].path) != "app-arm64-v8a-pro-release.apk" {
		t.Fatalf("flavored: %+v %v", outs, err)
	}
	if err := cleanBuildOutputs(proj, "release", "pro"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(apks, "app-arm64-v8a-release.apk")); err != nil {
		t.Fatal("cleaning a flavor removed the flavorless APK")
	}
	if _, err := os.Stat(filepath.Join(apks, "app-pro-release.apk")); err == nil {
		t.Fatal("the flavor's own APK survived the clean")
	}
}

// Presets come from the .yyt.json in the project directory only, and a file
// that cannot be read as written is an error rather than "no variants".
func TestFindVariants(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app")
	sibling := filepath.Join(root, "sibling")
	writeFile(t, filepath.Join(root, ContextFile), sampleVariants)
	writeFile(t, filepath.Join(sibling, "pubspec.yaml"), "")
	writeFile(t, filepath.Join(app, ContextFile), `{"team":"dooroo","variants":{"pro":{"flavor":"pro"}}}`)
	if vars, _, err := findVariants(sibling); len(vars) != 0 || err != nil {
		t.Fatalf("a file above must not force variants on a sibling app: %v %v", vars, err)
	}
	vars, p, err := findVariants(app)
	if err != nil || vars["pro"].Flavor != "pro" || p != filepath.Join(app, ContextFile) {
		t.Fatalf("variants: %+v at %s, %v", vars, p, err)
	}
	for _, bad := range []string{`{"team":"dooroo","variants":["lite","pro"]}`, `{"variants":{"pro":{"flavor":"pro","app":5}}}`, `{"variants":{"pro":{}},}`} {
		writeFile(t, filepath.Join(app, ContextFile), bad)
		if _, _, err := findVariants(app); err == nil {
			t.Fatalf("%s: a broken variants file must be an error", bad)
		}
	}
	// The team in a file with unusable variants is still read by the context search.
	setHome(t, root)
	writeFile(t, filepath.Join(app, ContextFile), `{"team":"dooroo","variants":["lite"]}`)
	if cf, _ := findContextFile(app); cf.Team != "dooroo" {
		t.Fatalf("team lost: %+v", cf)
	}
}

// A broken or ambiguous variants file stops deploy before any build.
func TestDeployRefusesUnusableVariants(t *testing.T) {
	for want, doc := range map[string]string{
		`"variants" must be`:      `{"team":"dooroo","variants":["lite","pro"]}`,
		"share the app":           `{"variants":{"a":{"flavor":"a","app":"demo","applicationId":"com.example.a"},"b":{"flavor":"b","app":"Demo","applicationId":"com.example.b"}}}`,
		`needs "app" and`:         `{"variants":{"pro":{"flavor":"pro"}}}`,
		"all build flavor pro":    `{"variants":{"a":{"flavor":"pro","app":"x","applicationId":"com.example.a"},"b":{"flavor":"pro","app":"y","applicationId":"com.example.b"}}}`,
		`variant pro has no "fla`: `{"variants":{"pro":{"app":"x"}}}`,
	} {
		proj := makeFlutterProject(t, "1.2.3+4")
		writeFile(t, filepath.Join(proj, ContextFile), doc)
		calls := fakeBuild(t, func(string, []string) error { return nil })
		f := newFake(t, ctxRoutes(nil, nil, nil, nil))
		withProject(t)
		args := []string{"catalog", "deploy", "--project-path", proj, "--variant", "pro"}
		if strings.Contains(want, "all build flavor") {
			args = []string{"catalog", "deploy", "--project-path", proj, "--flavor", "pro"}
		}
		_, _, err := run(t, f, args...)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: err = %v, want %q", doc, err, want)
		}
		if len(*calls) != 0 || len(f.reqs) != 0 {
			t.Fatalf("%s: side effects before the refusal", doc)
		}
	}
}

// A mismatch found after the build must not have created the app, and a
// flavorless debug build is tagged with the id Gradle packaged.
func TestDeployChecksBeforeCreatingAndTagsPackagedId(t *testing.T) {
	proj := makeFlutterProject(t, "1.0.0+1")
	packaged := "com.example.other"
	fakeBuild(t, func(dir string, _ []string) error {
		outs := filepath.Join(dir, "build", "app", "outputs")
		writeFile(t, filepath.Join(outs, "flutter-apk", "app-debug.apk"), "apk")
		writeFile(t, filepath.Join(outs, "apk", "debug", "output-metadata.json"), metadataJSON(packaged))
		return nil
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	routes := deployRoutes(&f, &committed, &listCalls, 1)
	routes["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
	created := false
	routes["POST /projects/prj_1/catalog/apps"] = func(recorded) (int, any) {
		created = true
		return 201, map[string]any{"id": "ca_1", "name": "demo", "path": "life.yyt.demo", "projectId": "prj_1", "createdAt": 1, "updatedAt": 1}
	}
	f = newFake(t, routes)
	withProject(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "does not match the expected") {
		t.Fatalf("err = %v, want a mismatch", err)
	}
	if created || len(committed) != 0 {
		t.Fatal("the app was created or an artifact uploaded before the id check")
	}
	packaged = "life.yyt.demo.debug"
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "debug", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if !created || len(committed) != 1 || committed[0]["application_id"] != "life.yyt.demo.debug" {
		t.Fatalf("created=%v uploads=%v", created, committed)
	}
}

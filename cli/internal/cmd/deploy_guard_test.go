package cmd

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/api"
)

// fakeGit is the repository deployOutput pretends to read.
type fakeGit struct {
	repo   bool
	head   string
	status string // `git status --porcelain=v1 --untracked-files=no`
	diff   string // `git diff HEAD` with pubspec.lock excluded
	log    string // subjects, newest first
	calls  []string

	fail       error  // every git command fails with this
	afterHead  func() // runs after HEAD was read (a commit landing mid-run)
	startHead  string // the HEAD the log must be read from ("" = head)
	aaptBroken error  // `aapt2 version` fails with this
}

func (g *fakeGit) logFrom() string {
	if g.startHead != "" {
		return g.startHead
	}
	return g.head
}

// fakeTools swaps the helper runner (git, aapt2) after fakeBuild. aapt, when
// set, is the installed aapt2: it gets the dump kind and the file.
func fakeTools(t *testing.T, g *fakeGit, aapt func(kind, file string) (string, error)) {
	t.Helper()
	deployOutput = func(_ context.Context, _, name string, args ...string) ([]byte, error) {
		switch name {
		case "git":
			if len(args) < len(gitBase) || strings.Join(args[:len(gitBase)], " ") != strings.Join(gitBase, " ") {
				t.Errorf("git ran without the read-only options: %v", args)
			}
			args = args[len(gitBase):]
			if g.fail != nil {
				return nil, g.fail
			}
			g.calls = append(g.calls, strings.Join(args, " "))
			if !g.repo {
				return nil, errors.New("exit status 128: fatal: not a git repository (or any of the parent directories): .git")
			}
			line := strings.Join(args, " ")
			switch {
			case line == "rev-parse --is-inside-work-tree":
				return []byte("true\n"), nil
			case line == "rev-parse -q --verify HEAD":
				if g.head == "" {
					return nil, errors.New("exit status 1")
				}
				head := g.head
				if g.afterHead != nil {
					g.afterHead()
				}
				return []byte(head + "\n"), nil
			case strings.HasPrefix(line, "rev-parse --short "):
				return []byte(args[2][:7] + "\n"), nil
			case strings.HasPrefix(line, "status --porcelain=v1 -z "):
				return []byte(strings.ReplaceAll(g.status, "\n", "\x00")), nil
			case args[0] == "diff":
				for _, want := range []string{"exclude,glob)**/pubspec.lock", "--no-ext-diff", "--no-textconv", "--submodule=diff"} {
					if !strings.Contains(line, want) {
						return nil, fmt.Errorf("the diff lacks %s", want)
					}
				}
				return []byte(g.diff), nil
			case strings.HasPrefix(line, "-c log.showSignature=false log ") && args[len(args)-1] == g.logFrom():
				return []byte(g.log), nil
			}
			// Anything else would be a write, or a command the guard does not need.
			t.Errorf("unexpected git %v", args)
			return nil, errors.New("unexpected git command")
		case "fake-aapt2":
			if aapt == nil {
				break
			}
			if args[0] == "version" {
				return []byte("Android Asset Packaging Tool (aapt) 2.19"), g.aaptBroken
			}
			if !filepath.IsAbs(args[len(args)-1]) {
				t.Errorf("aapt2 got a relative path: %v", args)
			}
			out, err := aapt(args[1], args[len(args)-1])
			return []byte(out), err
		}
		return nil, fmt.Errorf("%s is not available in this test", name)
	}
	if aapt != nil {
		findAAPT2 = func(...string) (string, error) { return "fake-aapt2", nil }
	}
}

func metadataWithCodes(id string, codes map[string]int) string {
	var els []string
	for abi, code := range codes {
		filters := ""
		if abi != "" {
			filters = fmt.Sprintf(`{"filterType":"ABI","value":%q}`, abi)
		}
		els = append(els, fmt.Sprintf(`{"filters":[%s],"versionCode":%d}`, filters, code))
	}
	return fmt.Sprintf(`{"version":3,"applicationId":%q,"elements":[%s]}`, id, strings.Join(els, ","))
}

func writeBundle(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, _ := zw.Create("base/manifest/AndroidManifest.xml")
	_, _ = w.Write([]byte("proto"))
	_ = zw.Close()
	_ = f.Close()
}

func xmltreeOf(pkg string, code int) string {
	return fmt.Sprintf(`  E: manifest (line=2)
    A: package="%s" (Raw: "%s")
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=%d (Raw: "%d")
      E: uses-sdk (line=7)
        A: http://schemas.android.com/apk/res/android:minSdkVersion(0x0101020c)=24 (Raw: "24")
        A: http://schemas.android.com/apk/res/android:targetSdkVersion(0x01010270)=36 (Raw: "36")
`, pkg, pkg, code, code)
}

func badgingOf(pkg string, code int) string {
	return fmt.Sprintf("package: name='%s' versionCode='%d' versionName='1.2.3'\nminSdkVersion:'24'\ntargetSdkVersion:'36'\n", pkg, code)
}

// deployFake is the console for one deploy run.
func deployFake(t *testing.T) (*fakeConsole, *[]map[string]any) {
	t.Helper()
	committed := &[]map[string]any{}
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, committed, &listCalls, 1))
	withProject(t)
	return f, committed
}

// --version-code-offset: every split APK must carry offset + pubspec build.
func TestDeployVersionCodeOffset(t *testing.T) {
	cases := []struct {
		name  string
		codes map[string]int
		want  string // "" = uploaded
	}{
		{"match", map[string]int{"arm64-v8a": 2004, "x86_64": 2004}, ""},
		{"abi offset stacked", map[string]int{"arm64-v8a": 2004, "x86_64": 4004}, "force-version-code-ignoring-abi"},
		{"plain build number", map[string]int{"arm64-v8a": 4, "x86_64": 4}, "expected 2004 (offset 2000 + pubspec build 4)"},
		{"metadata without this output", map[string]int{"": 2004}, "cannot read the versionCode"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			fakeBuild(t, func(dir string, _ []string) error {
				outs := filepath.Join(dir, "build", "app", "outputs")
				writeFile(t, filepath.Join(outs, "flutter-apk", "app-arm64-v8a-release.apk"), "a")
				writeFile(t, filepath.Join(outs, "flutter-apk", "app-x86_64-release.apk"), "b")
				writeFile(t, filepath.Join(outs, "apk", "release", "output-metadata.json"), metadataWithCodes("life.yyt.demo", c.codes))
				return nil
			})
			f, committed := deployFake(t)
			_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--split-per-abi",
				"--version-code-offset", "2000", "--no-verify")
			if c.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				if len(*committed) != 2 || (*committed)[0]["version_code"] != "2004" || (*committed)[1]["version_code"] != "2004" {
					t.Fatalf("uploads: %v", *committed)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if len(*committed) != 0 {
				t.Fatalf("uploaded despite the versionCode check: %v", *committed)
			}
		})
	}
}

// The offset needs a build number, and is refused before anything happens.
func TestDeployVersionCodeOffsetNeedsBuildNumber(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3")
	calls := fakeBuild(t, func(string, []string) error { return nil })
	f, _ := deployFake(t)
	for want, args := range map[string][]string{
		"needs a build number":  {"--version-code-offset", "2000"},
		"must not be negative":  {"--version-code-offset", "-1"},
		"invalid --version-tag": {"--version-tag", "short"},
		"--note-skip":           {"--note-skip", "("},
	} {
		_, _, err := run(t, f, append([]string{"catalog", "deploy", "--project-path", proj}, args...)...)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	if len(*calls) != 0 || len(f.reqs) != 0 {
		t.Fatalf("side effects before the refusal: %d build(s), %d request(s)", len(*calls), len(f.reqs))
	}
}

// A bundle is read with aapt2: its id is checked like an APK's, its
// versionCode against the offset, and the tags carry what the file says.
func TestDeployBundleWithAapt2(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	aab := filepath.Join(proj, "build", "app", "outputs", "bundle", "proRelease", "app-pro-release.aab")
	fakeBuild(t, func(string, []string) error { writeBundle(t, aab); return nil })
	pkg, code := "com.example.sample.pro", 2004
	var g fakeGit
	fakeTools(t, &g, func(kind, _ string) (string, error) {
		if kind != "xmltree" {
			return "", fmt.Errorf("bundle read with %s", kind)
		}
		return xmltreeOf(pkg, code), nil
	})
	args := []string{"catalog", "deploy", "--project-path", proj, "--flavor", "pro", "--name", "demo",
		"--application-id", "com.example.sample.pro", "--build-profile", "aab", "--version-code-offset", "2000", "--no-verify"}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, append(args, "--target-sdk", "35")...); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{"application_id": pkg, "version_code": "2004", "min_sdk": "24", "target_sdk": "35", "version": "1.2.3+4"} {
		if (*committed)[0][k] != want {
			t.Fatalf("tag %s = %v, want %s", k, (*committed)[0][k], want)
		}
	}
	out, _, err := run(t, f, append(args, "--no-upload", "--json")...)
	if err != nil || !strings.Contains(out, `"applicationId": "com.example.sample.pro"`) || !strings.Contains(out, `"versionCode": 2004`) {
		t.Fatalf("--no-upload --json: %v\n%s", err, out)
	}
	for want, set := range map[string]func(){
		"does not match the expected": func() { pkg, code = "com.example.sample", 2004 },
		"expected 2004":               func() { pkg, code = "com.example.sample.pro", 4 },
	} {
		set()
		f, committed := deployFake(t)
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want %q", err, want)
		}
		if len(*committed) != 0 {
			t.Fatalf("uploaded a bundle that failed its check: %v", *committed)
		}
	}
}

// Without aapt2 a bundle is uploaded unchecked with a note, but a requested
// versionCode check fails instead of passing.
func TestDeployBundleWithoutAapt2(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := fakeBuild(t, func(dir string, _ []string) error {
		writeBundle(t, filepath.Join(dir, "build", "app", "outputs", "bundle", "release", "app-release.aab"))
		return nil
	})
	f, committed := deployFake(t)
	_, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "aab", "--no-verify")
	if err != nil || !strings.Contains(errs, "aapt2 not found") {
		t.Fatalf("err=%v stderr:\n%s", err, errs)
	}
	if got := (*committed)[0]; got["application_id"] != "life.yyt.demo" || got["version_code"] != nil || got["min_sdk"] != nil {
		t.Fatalf("tags: %v", got)
	}
	f, committed = deployFake(t)
	_, _, err = run(t, f, "catalog", "deploy", "--project-path", proj, "--build-profile", "aab", "--version-code-offset", "2000", "--no-verify")
	if err == nil || !strings.Contains(err.Error(), "needs aapt2 to read the versionCode") || len(*committed) != 0 || len(*calls) != 1 {
		t.Fatalf("err = %v, uploads %v, builds %d (the refusal must come before the build)", err, *committed, len(*calls))
	}
}

// An installed aapt2 must agree with Gradle's metadata, and its failure is
// never an unchecked pass.
func TestDeployApkAapt2CrossCheck(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	fakeBuild(t, func(dir string, _ []string) error {
		outs := filepath.Join(dir, "build", "app", "outputs")
		writeFile(t, filepath.Join(outs, "flutter-apk", "app-release.apk"), "a")
		writeFile(t, filepath.Join(outs, "apk", "release", "output-metadata.json"), metadataWithCodes("life.yyt.demo", map[string]int{"": 2004}))
		return nil
	})
	reply, fail := badgingOf("life.yyt.demo", 2004), error(nil)
	var g fakeGit
	fakeTools(t, &g, func(kind, _ string) (string, error) {
		if kind != "badging" {
			return "", fmt.Errorf("apk read with %s", kind)
		}
		return reply, fail
	})
	args := []string{"catalog", "deploy", "--project-path", proj, "--no-verify"}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, args...); err != nil {
		t.Fatal(err)
	}
	if got := (*committed)[0]; got["version_code"] != "2004" || got["min_sdk"] != "24" || got["target_sdk"] != "36" {
		t.Fatalf("tags: %v", got)
	}
	for want, set := range map[string]func(){
		"Gradle's output metadata says life.yyt.demo": func() { reply = badgingOf("life.yyt.other", 2004) },
		"Gradle's output metadata says 2004":          func() { reply = badgingOf("life.yyt.demo", 7) },
		"aapt2 dump badging":                          func() { fail = errors.New("exit status 1") },
	} {
		reply, fail = badgingOf("life.yyt.demo", 2004), nil
		set()
		f, committed := deployFake(t)
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want %q", err, want)
		}
		if len(*committed) != 0 {
			t.Fatalf("uploaded an APK that failed its check: %v", *committed)
		}
	}
}

func buildsPlainApk(t *testing.T, during func()) *[][]string {
	return fakeBuild(t, func(dir string, _ []string) error {
		outs := filepath.Join(dir, "build", "app", "outputs")
		writeFile(t, filepath.Join(outs, "flutter-apk", "app-release.apk"), "a")
		writeFile(t, filepath.Join(outs, "apk", "release", "output-metadata.json"), metadataWithCodes("life.yyt.demo", map[string]int{"": 4}))
		if during != nil {
			during()
		}
		return nil
	})
}

const headA, headB = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// --version-tag marketing, --commit auto and --note auto (+ --note-skip).
func TestDeployMarketingTagAndGitDefaults(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	buildsPlainApk(t, nil)
	g := fakeGit{repo: true, head: headA,
		log: "Update pubspec.lock after Flutter build\nBump version to 1.2.3+4\nFix the crash on resume\nOlder work\n"}
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	out, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--version-tag", "marketing",
		"--commit", "auto", "--note", "auto", "--note-skip", "^Bump version to ", "--note-skip", `^Update pubspec\.lock`,
		"--no-verify", "--json")
	if err != nil {
		t.Fatal(err)
	}
	got := (*committed)[0]
	for k, want := range map[string]any{"version": "1.2.3", "commit": "1111111", "changelog": "Fix the crash on resume", "version_code": "4", "build": nil} {
		if got[k] != want {
			t.Fatalf("tag %s = %v, want %v", k, got[k], want)
		}
	}
	if !strings.Contains(out, `"commit": "1111111"`) || !strings.Contains(out, `"version": "1.2.3"`) {
		t.Fatalf("--json:\n%s", out)
	}
	// The upload keeps the full version in the file name.
	if _, err := os.Stat(filepath.Join(proj, "build", "app", "outputs", "flutter-apk", "demo-1.2.3+4-release.apk")); err != nil {
		t.Fatal(err)
	}
	// Every subject skipped is an error, not an empty changelog.
	f, committed = deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--note", "auto", "--note-skip", ".", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "--note auto") || len(*committed) != 0 {
		t.Fatalf("err = %v", err)
	}
	// --no-upload keeps the commit and does not need the note.
	out, _, err = run(t, f, "catalog", "deploy", "--project-path", proj, "--commit", "auto", "--note", "auto", "--note-skip", ".", "--no-upload", "--json")
	if err != nil || !strings.Contains(out, `"commit": "1111111"`) || !strings.Contains(out, `"versionCode": 4`) {
		t.Fatalf("--no-upload: %v\n%s", err, out)
	}
	for _, call := range g.calls {
		switch strings.Fields(call)[0] {
		case "rev-parse", "status", "diff", "log", "-c":
		default:
			t.Fatalf("deploy ran git %s", call)
		}
	}
}

// Outside a repository the git-backed options fail and the guard is off.
func TestDeployWithoutGitRepository(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsPlainApk(t, nil)
	f, committed := deployFake(t)
	for _, args := range [][]string{{"--commit", "auto"}, {"--note", "auto"}, {"--require-clean"}} {
		_, _, err := run(t, f, append([]string{"catalog", "deploy", "--project-path", proj, "--no-verify"}, args...)...)
		if err == nil || !strings.Contains(err.Error(), "needs a git repository") {
			t.Fatalf("%v: err = %v", args, err)
		}
	}
	if len(*calls) != 0 || len(f.reqs) != 0 {
		t.Fatal("side effects before the refusal")
	}
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify"); err != nil || len(*committed) != 1 {
		t.Fatalf("a plain deploy outside git must work: %v", err)
	}
}

// The drift guard refuses the upload when HEAD or a tracked file changed
// while building; pubspec.lock alone does not count.
func TestDeployDriftGuard(t *testing.T) {
	cases := []struct {
		name   string
		during func(g *fakeGit)
		args   []string
		want   string
	}{
		{"nothing changed", func(*fakeGit) {}, nil, ""},
		{"only pubspec.lock", func(g *fakeGit) { g.status = " M README.md\n M pubspec.lock\n M app/pubspec.lock\n" }, nil, ""},
		{"HEAD moved", func(g *fakeGit) { g.head = headB }, nil, "HEAD moved from 1111111aaaaa to 2222222bbbbb"},
		{"tracked file changed", func(g *fakeGit) { g.status = " M lib/main.dart\n M pubspec.lock\n"; g.diff = "x" }, nil, "tracked files changed: lib/main.dart"},
		{"dirty file changed again", func(g *fakeGit) { g.diff = "again" }, nil, "tracked files changed again"},
		{"guard off", func(g *fakeGit) { g.head = headB }, []string{"--no-drift-check"}, ""},
		{"no upload", func(g *fakeGit) { g.head = headB }, []string{"--no-upload"}, "HEAD moved"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			g := fakeGit{repo: true, head: headA, status: " M README.md\n", diff: "start"}
			buildsPlainApk(t, func() { c.during(&g) })
			fakeTools(t, &g, nil)
			f, committed := deployFake(t)
			out, _, err := run(t, f, append([]string{"catalog", "deploy", "--project-path", proj, "--no-verify"}, c.args...)...)
			if c.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if len(*committed) != 0 || strings.Contains(out, ".apk") {
				t.Fatalf("uploaded or reported a drifted build: %v\n%s", *committed, out)
			}
		})
	}
}

// The baseline is taken after --do-bump, so the bumped pubspec is not drift;
// --require-clean looks before the bump and ignores pubspec.lock.
func TestDeployDriftBaselineAndRequireClean(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	g := fakeGit{repo: true, head: headA, status: " M pubspec.lock\n"}
	calls := buildsPlainApk(t, nil)
	fakeTools(t, &g, nil)
	// The fake repository reports pubspec.yaml as modified once it was bumped.
	real := deployOutput
	deployOutput = func(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
		if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); strings.Contains(string(b), "1.2.4+5") {
			g.status, g.diff = " M pubspec.lock\n M pubspec.yaml\n", "bumped"
		}
		return real(ctx, dir, name, args...)
	}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--do-bump", "--require-clean",
		"--version-code-offset", "0", "--no-verify"); err == nil || !strings.Contains(err.Error(), "expected 5 (offset 0 + pubspec build 5)") {
		// versionCode 4 was packaged by the fake; the check proves the bumped build number is used.
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 1 || len(*committed) != 0 {
		t.Fatalf("builds %d uploads %d", len(*calls), len(*committed))
	}
	deployOutput = real
	g.status = " M lib/main.dart\n"
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--require-clean", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "--require-clean: tracked files are modified: lib/main.dart") {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 1 {
		t.Fatal("built a dirty tree despite --require-clean")
	}
}

// --no-create fails with a not-found before the build.
func TestDeployNoCreate(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsPlainApk(t, nil)
	committed := &[]map[string]any{}
	listCalls := 0
	var f *fakeConsole
	routes := deployRoutes(&f, committed, &listCalls, 1)
	routes["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
	created := false
	routes["POST /projects/prj_1/catalog/apps"] = func(recorded) (int, any) {
		created = true
		return 201, map[string]any{"id": "ca_1", "name": "demo", "path": "life.yyt.demo", "projectId": "prj_1", "createdAt": 1, "updatedAt": 1}
	}
	f = newFake(t, routes)
	withProject(t)
	_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-create", "--no-verify")
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != 404 || !strings.Contains(err.Error(), "--no-create") {
		t.Fatalf("err = %v, want a not-found", err)
	}
	if created || len(*calls) != 0 || len(*committed) != 0 {
		t.Fatalf("created=%v builds=%d uploads=%d", created, len(*calls), len(*committed))
	}
}

// A git that fails inside a checkout is an error, never "no repository":
// the drift guard would otherwise be off without a word.
func TestDeployGitFailureIsNotNoRepository(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsPlainApk(t, nil)
	hasDotGit = func(string) bool { return true }
	g := fakeGit{repo: true, head: headA, fail: errors.New("exit status 128: fatal: detected dubious ownership in repository")}
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--do-bump", "--no-verify")
	if err == nil || !strings.Contains(err.Error(), "dubious ownership") || !strings.Contains(err.Error(), "--no-drift-check") {
		t.Fatalf("err = %v, want the git failure", err)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(*calls) != 0 || len(*committed) != 0 || !strings.Contains(string(b), "1.2.3+4") {
		t.Fatalf("side effects after a git failure: builds %d, uploads %d, pubspec %s", len(*calls), len(*committed), b)
	}
	g.fail = errors.New("exit status 128: fatal: not a git repository: /mnt/gone/.git/worktrees/app")
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify"); err == nil || !strings.Contains(err.Error(), "cannot read the git repository") {
		t.Fatalf("a .git whose gitdir is missing must not read as no repository: %v", err)
	}
	// The caller can still choose to build without the guard; git is then not asked at all.
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-drift-check", "--no-verify"); err != nil || len(*committed) != 1 {
		t.Fatalf("--no-drift-check: %v", err)
	}
}

// A repository without a commit still deploys; the auto options need one.
func TestDeployUnbornHead(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	buildsPlainApk(t, nil)
	g := fakeGit{repo: true}
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify"); err != nil || len(*committed) != 1 {
		t.Fatalf("unborn HEAD: %v", err)
	}
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--commit", "auto", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "need a commit") {
		t.Fatalf("err = %v", err)
	}
}

// The commit tag, the note and the baseline come from one HEAD: a commit
// that lands between reading them and the build is refused.
func TestDeployHeadMovedBeforeBuild(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsPlainApk(t, nil)
	g := fakeGit{repo: true, head: headA, startHead: headA, log: "Subject\n"}
	moved := false
	g.afterHead = func() {
		if !moved {
			moved = true
			g.head = headB
		}
	}
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--commit", "auto", "--note", "auto", "--no-verify")
	if err == nil || !strings.Contains(err.Error(), "before the build started") || len(*calls) != 0 || len(*committed) != 0 {
		t.Fatalf("err = %v, builds %d, uploads %d", err, len(*calls), len(*committed))
	}
}

// Tags deploy reads from the file cannot be overridden, and a wrong or
// unusable tool is found before pubspec is bumped.
func TestDeployRefusesBeforeBump(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := buildsPlainApk(t, nil)
	var g fakeGit
	fakeTools(t, &g, func(string, string) (string, error) { return badgingOf("life.yyt.demo", 4), nil })
	g.aaptBroken = errors.New("exec format error")
	f, committed := deployFake(t)
	t.Setenv("AAPT2", "")
	for want, args := range map[string][]string{
		"--tag version_code: deploy sets":   {"--tag", "version_code=999"},
		"--tag application_id: deploy sets": {"--tag", "application_id=com.example.other"},
		"needs aapt2 to read":               {"--build-profile", "aab", "--version-code-offset", "0"},
	} {
		_, _, err := run(t, f, append([]string{"catalog", "deploy", "--project-path", proj, "--do-bump", "--no-verify"}, args...)...)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	// Named by the caller, a tool that does not run is an error.
	t.Setenv("AAPT2", filepath.Join(proj, "pubspec.yaml"))
	findAAPT2 = func(...string) (string, error) { return "fake-aapt2", nil }
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--do-bump", "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "does not run") {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(*calls) != 0 || !strings.Contains(string(b), "1.2.3+4") {
		t.Fatalf("bumped or built before the refusal: %d build(s), %s", len(*calls), b)
	}
	// Found in the SDK but unusable: a note, and the deploy goes on without it.
	t.Setenv("AAPT2", "")
	_, errs, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify")
	if err != nil || !strings.Contains(errs, "does not run") || len(*committed) != 1 || (*committed)[0]["min_sdk"] != nil {
		t.Fatalf("err=%v uploads=%v stderr:\n%s", err, *committed, errs)
	}
}

func TestAutoNoteCleansAndCuts(t *testing.T) {
	long := strings.Repeat("가", 400) // 1200 bytes
	g := fakeGit{repo: true, head: headA, log: "\x1b]0;title\x07Bump version\n \n" + long + "\n"}
	fakeBuild(t, func(string, []string) error { return nil })
	fakeTools(t, &g, nil)
	note, err := autoNote(context.Background(), ".", headA, nil)
	if err != nil || strings.ContainsAny(note, "\x1b\x07") || !strings.Contains(note, "Bump version") {
		t.Fatalf("note %q, %v", note, err)
	}
	g.log = long + "\n"
	note, err = autoNote(context.Background(), ".", headA, nil)
	if err != nil || len(note) > maxNote || len(note) < maxNote-3 || !strings.HasPrefix(long, note) {
		t.Fatalf("cut to %d bytes, %v", len(note), err)
	}
}

func TestStatusPathsAndSdkDir(t *testing.T) {
	// `git status --porcelain=v1 -z`: a rename is followed by its source.
	out := " M lib/a -> b.dart\x00R  new name.dart\x00old.dart\x00 M pubspec.lock\x00"
	got := strings.Join(statusPaths([]byte(out)), "|")
	if got != "lib/a -> b.dart|new name.dart|pubspec.lock" {
		t.Fatalf("paths: %s", got)
	}
	if s := summarize([]string{"a\x1b[31m.txt"}); strings.Contains(s, "\x1b") {
		t.Fatalf("control characters in a file name: %q", s)
	}
	proj := t.TempDir()
	if sdkDirOf(proj) != "" {
		t.Fatal("no local.properties")
	}
	writeFile(t, filepath.Join(proj, "android", "local.properties"), "flutter.sdk=/opt/flutter\r\nsdk.dir=C\\:\\\\Users\\\\dev\\\\Android\\\\Sdk\r\n")
	if got := sdkDirOf(proj); got != `C:\Users\dev\Android\Sdk` {
		t.Fatalf("sdk.dir = %q", got)
	}
}

// The baseline is the state after the bump: a bumped pubspec.yaml is not
// drift, and the upload goes through.
func TestDeployBumpIsNotDrift(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	g := fakeGit{repo: true, head: headA}
	buildsPlainApk(t, nil)
	fakeTools(t, &g, nil)
	inner := deployOutput
	deployOutput = func(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
		if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); strings.Contains(string(b), "1.2.4+5") {
			g.status, g.diff = " M pubspec.yaml\n", "bumped"
		}
		return inner(ctx, dir, name, args...)
	}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--do-bump", "--require-clean", "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if len(*committed) != 1 || (*committed)[0]["version"] != "1.2.4+5" {
		t.Fatalf("uploads: %v", *committed)
	}
}

// A git that fails at the final snapshot is a refusal, not "no drift".
func TestDeployDriftCheckFailsClosed(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	g := fakeGit{repo: true, head: headA}
	buildsPlainApk(t, func() { g.fail = errors.New("exit status 128: fatal: index file corrupt") })
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify"); err == nil ||
		!strings.Contains(err.Error(), "index file corrupt") || len(*committed) != 0 {
		t.Fatalf("err = %v, uploads %v", err, *committed)
	}
}

// --no-upload still runs the checks, and --no-drift-check does not switch
// off the options that read git.
func TestDeployGuardsWithoutUploadOrDriftCheck(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	g := fakeGit{repo: true, head: headA, status: " M lib/main.dart\n", log: "Subject\n"}
	calls := buildsPlainApk(t, nil)
	fakeTools(t, &g, nil)
	f, committed := deployFake(t)
	base := []string{"catalog", "deploy", "--project-path", proj, "--no-verify"}
	if _, _, err := run(t, f, append(base, "--no-upload", "--require-clean")...); err == nil || !strings.Contains(err.Error(), "--require-clean") {
		t.Fatalf("err = %v", err)
	}
	if _, _, err := run(t, f, append(base, "--no-drift-check", "--require-clean")...); err == nil || !strings.Contains(err.Error(), "--require-clean") {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 0 {
		t.Fatal("built despite --require-clean")
	}
	out, _, err := run(t, f, append(base, "--no-upload", "--version-code-offset", "2000")...)
	if err == nil || !strings.Contains(err.Error(), "expected 2004") || strings.Contains(out, ".apk") {
		t.Fatalf("--no-upload must keep the versionCode check: %v\n%s", err, out)
	}
	if _, _, err := run(t, f, append(base, "--no-drift-check", "--commit", "auto", "--note", "auto")...); err != nil {
		t.Fatal(err)
	}
	if got := (*committed)[0]; got["commit"] != "1111111" || got["changelog"] != "Subject" {
		t.Fatalf("tags: %v", got)
	}
}

// A flavored APK without Gradle metadata is checked through aapt2 when it is
// installed; aapt2 is looked up in the project's SDK and gets absolute paths
// even for a relative --project-path; --min-sdk wins over the file's value.
func TestDeployFlavorApkReadByAapt2(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, "android", "local.properties"), "sdk.dir=/opt/project-sdk\n")
	fakeBuild(t, func(dir string, _ []string) error {
		writeFile(t, filepath.Join(dir, "build", "app", "outputs", "flutter-apk", "app-pro-release.apk"), "apk")
		return nil
	})
	pkg := "com.example.sample.pro"
	var g fakeGit
	fakeTools(t, &g, func(string, string) (string, error) { return badgingOf(pkg, 4), nil })
	var sdks []string
	findAAPT2 = func(dirs ...string) (string, error) { sdks = dirs; return "fake-aapt2", nil }
	t.Chdir(filepath.Dir(proj))
	args := []string{"catalog", "deploy", "--project-path", filepath.Base(proj), "--flavor", "pro", "--name", "demo",
		"--application-id", "com.example.sample.pro", "--min-sdk", "21", "--no-verify"}
	f, committed := deployFake(t)
	if _, _, err := run(t, f, args...); err != nil {
		t.Fatal(err)
	}
	if got := (*committed)[0]; got["application_id"] != pkg || got["version_code"] != "4" || got["min_sdk"] != "21" || got["target_sdk"] != "36" {
		t.Fatalf("tags: %v", got)
	}
	if len(sdks) != 1 || sdks[0] != "/opt/project-sdk" {
		t.Fatalf("aapt2 was not looked up in the project's sdk.dir: %v", sdks)
	}
	pkg = "com.example.sample"
	f, committed = deployFake(t)
	if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), "does not match the expected") || len(*committed) != 0 {
		t.Fatalf("err = %v", err)
	}
}

// gitSnapshot against a real repository: the fakes above only pin substrings
// of the command line.
func TestGitSnapshotRealGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	app := filepath.Join(root, "apps", "demo")
	mustGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	mustGit("init", "-q")
	if ok, err := inGitRepo(ctx, root); !ok || err != nil {
		t.Fatalf("inGitRepo: %v, %v", ok, err)
	}
	if st, err := gitSnapshot(ctx, root); err != nil || st.head != "" {
		t.Fatalf("unborn HEAD: %+v, %v", st, err)
	}
	for name, body := range map[string]string{
		"pubspec.lock": "root", "apps/demo/pubspec.lock": "app", "apps/demo/pubspec.yaml": "v1",
		"apps/demo/lib/main.dart": "a", "tools/a file.sh": "x", "README.md": "r",
	} {
		writeFile(t, filepath.Join(root, filepath.FromSlash(name)), body)
	}
	mustGit("add", "-A")
	mustGit("commit", "-qm", "first")
	base, err := gitSnapshot(ctx, app)
	if err != nil || len(base.head) != 40 || len(base.changed) != 0 {
		t.Fatalf("clean: %+v, %v", base, err)
	}
	snap := func() gitState {
		t.Helper()
		st, err := gitSnapshot(ctx, app)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	// Lockfiles at any depth and untracked files are not drift.
	writeFile(t, filepath.Join(root, "pubspec.lock"), "root2")
	writeFile(t, filepath.Join(app, "pubspec.lock"), "app2")
	writeFile(t, filepath.Join(app, "build", "out.apk"), "untracked")
	if d := base.drift(snap()); d != "" {
		t.Fatalf("lockfiles and untracked files counted as drift: %s", d)
	}
	// A file outside the project directory, with a space in its path.
	writeFile(t, filepath.Join(root, "tools", "a file.sh"), "y")
	dirty := snap()
	if d := base.drift(dirty); !strings.Contains(d, "tools/a file.sh") {
		t.Fatalf("drift = %q", d)
	}
	// Staged, then staged again with other content.
	mustGit("add", "-A")
	staged := snap()
	writeFile(t, filepath.Join(root, "tools", "a file.sh"), "z")
	mustGit("add", "-A")
	if d := staged.drift(snap()); d == "" {
		t.Fatal("a re-staged change was not seen")
	}
	// A rename, and a new commit.
	mustGit("mv", "README.md", "READ ME.md")
	if d := base.drift(snap()); !strings.Contains(d, "READ ME.md") {
		t.Fatalf("rename: %q", d)
	}
	mustGit("commit", "-qm", "Bump version to 2")
	if d := base.drift(snap()); !strings.Contains(d, "HEAD moved") {
		t.Fatalf("commit: %q", d)
	}
	note, err := autoNote(ctx, app, snap().head, []*regexp.Regexp{regexp.MustCompile("^Bump version to ")})
	if err != nil || note != "first" {
		t.Fatalf("note %q, %v", note, err)
	}
	if hasDotGit(app) != true || dotGitAbove(app) != true {
		t.Fatal("the .git above the project was not found")
	}
}

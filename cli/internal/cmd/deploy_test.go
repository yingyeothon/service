package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeFlutterProject writes the minimal files deploy reads.
func makeFlutterProject(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"),
		[]byte("name: demo\nversion: "+version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gradle := filepath.Join(dir, "android", "app")
	_ = os.MkdirAll(gradle, 0o755)
	if err := os.WriteFile(filepath.Join(gradle, "build.gradle"),
		[]byte(`applicationId "life.yyt.demo"`), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fakeBuild swaps deployRunner with one that creates output files.
func fakeBuild(t *testing.T, fn func(dir string, args []string) error) *[][]string {
	t.Helper()
	var calls [][]string
	prev := deployRunner
	deployRunner = func(_ context.Context, dir, name string, args ...string) error {
		if name != "flutter" {
			return fmt.Errorf("unexpected command %s", name)
		}
		calls = append(calls, args)
		return fn(dir, args)
	}
	t.Cleanup(func() { deployRunner = prev })
	return &calls
}

// deployRoutes builds the console routes deploy touches. committed collects
// the tag maps sent to presign, listed serves the artifact list responses.
func deployRoutes(f **fakeConsole, committed *[]map[string]any, listCalls *int, listAfter int) map[string]func(recorded) (int, any) {
	n := 0
	demo := map[string]any{
		"id": "ca_1", "name": "demo", "path": "life.yyt.demo", "projectId": "prj_1", "projectName": "game",
		"teamId": "team_1", "teamName": "dooroo", "createdAt": 1, "updatedAt": 1,
	}
	return ctxRoutes(map[string]func(recorded) (int, any){
		"GET /catalog/apps/ca_1": func(recorded) (int, any) { return 200, demo },
		"POST /catalog/apps/ca_1/artifacts": func(r recorded) (int, any) {
			*committed = append(*committed, r.Body["tags"].(map[string]any))
			n++
			return 201, map[string]any{
				"uploadId": fmt.Sprintf("u%d", n), "key": "k",
				"url": (*f).srv.URL + "/s3put", "method": "PUT",
				"headers": map[string]string{}, "expiresAt": 1,
			}
		},
		"PUT /s3put": func(recorded) (int, any) { return 200, nil },
		"POST /catalog/uploads/u1/commit": func(recorded) (int, any) {
			return 200, map[string]any{"id": "art_1", "appId": "ca_1", "platform": "android",
				"url": "https://d/1", "tags": map[string]string{"build_type": "release", "abi": "arm64-v8a"}, "createdAt": 1}
		},
		"POST /catalog/uploads/u2/commit": func(recorded) (int, any) {
			return 200, map[string]any{"id": "art_2", "appId": "ca_1", "platform": "android",
				"url": "https://d/2", "tags": map[string]string{"build_type": "appbundle"}, "createdAt": 1}
		},
		"GET /catalog/apps/ca_1/artifacts": func(recorded) (int, any) {
			*listCalls++
			if *listCalls < listAfter {
				return 200, map[string]any{"artifacts": []any{}}
			}
			arts := make([]any, 0, n)
			for i := 1; i <= n; i++ {
				arts = append(arts, map[string]any{
					"id": fmt.Sprintf("art_%d", i), "appId": "ca_1", "platform": "android",
					"url": "https://d", "tags": map[string]string{"version": "1.2.3+4"}, "createdAt": 1,
				})
			}
			return 200, map[string]any{"artifacts": arts}
		},
	}, nil, []any{demo}, nil)
}

func TestDeploySplitPerAbiAndAabAlias(t *testing.T) {
	prevDelay := verifyDelay
	verifyDelay = time.Millisecond
	t.Cleanup(func() { verifyDelay = prevDelay })

	proj := makeFlutterProject(t, "1.2.3+4")
	calls := fakeBuild(t, func(dir string, args []string) error {
		out := filepath.Join(dir, "build", "app", "outputs")
		if args[1] == "appbundle" {
			p := filepath.Join(out, "bundle", "release")
			_ = os.MkdirAll(p, 0o755)
			return os.WriteFile(filepath.Join(p, "app-release.aab"), []byte("aab"), 0o644)
		}
		p := filepath.Join(out, "flutter-apk")
		_ = os.MkdirAll(p, 0o755)
		return os.WriteFile(filepath.Join(p, "app-arm64-v8a-release.apk"), []byte("apk"), 0o644)
	})

	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, &committed, &listCalls, 2)) // first verify empty → retry

	// deploy is a write: no context → refused before any build or request.
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj); err == nil ||
		!strings.Contains(err.Error(), "no team context") {
		t.Fatalf("err=%v", err)
	}
	if len(*calls) != 0 || len(f.reqs) != 0 {
		t.Fatal("must not build or call the API without a context")
	}
	// .yyt.json next to the Flutter project supplies it (searched from --project-path).
	if err := os.WriteFile(filepath.Join(proj, ContextFile), []byte(`{"team":"dooroo","project":"game"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	out, errs, err := run(t, f, "catalog", "deploy",
		"--project-path", proj, "--build-profile", "release", "--build-profile", "aab",
		"--split-per-abi", "--target-platform", "android-arm64",
		"--stage", "beta", "--note", "hello", "--build", "4", "--commit", "abc123",
		"--min-sdk", "23", "--target-sdk", "34", "--tag", "package_type=apk")
	if err != nil {
		t.Fatal(err)
	}
	// build args carried the split/target-platform flags for the APK profile
	if got := strings.Join((*calls)[0], " "); got != "build apk --release --split-per-abi --target-platform android-arm64" {
		t.Fatalf("apk build args: %q", got)
	}
	// appbundle build never gets --split-per-abi
	if got := strings.Join((*calls)[1], " "); strings.Contains(got, "--split-per-abi") ||
		!strings.Contains(got, "build appbundle --release") {
		t.Fatalf("aab build args: %q", got)
	}
	if len(committed) != 2 {
		t.Fatalf("expected 2 uploads, got %d", len(committed))
	}
	apk := committed[0]
	for k, want := range map[string]string{
		"version": "1.2.3+4", "build_type": "release", "application_id": "life.yyt.demo",
		"stage": "beta", "changelog": "hello", "build": "4", "commit": "abc123",
		"min_sdk": "23", "target_sdk": "34", "abi": "arm64-v8a", "package_type": "apk",
	} {
		if apk[k] != want {
			t.Fatalf("apk tag %s = %v (want %s)", k, apk[k], want)
		}
	}
	if committed[1]["build_type"] != "appbundle" {
		t.Fatalf("aab alias not normalized: %v", committed[1]["build_type"])
	}
	if _, ok := committed[1]["abi"]; ok {
		t.Fatalf("aab must not carry a split abi tag: %v", committed[1])
	}
	if listCalls != 2 {
		t.Fatalf("verify should have retried once, listCalls=%d", listCalls)
	}
	if !strings.Contains(out, "art_1") || !strings.Contains(out, "art_2") {
		t.Fatalf("output:\n%s", out)
	}
	if !strings.Contains(errs, "deploying demo to team dooroo / project game") {
		t.Fatalf("stderr must name the resolved context:\n%s", errs)
	}
}

func TestDeployCreatesMissingApp(t *testing.T) {
	prevDelay := verifyDelay
	verifyDelay = time.Millisecond
	t.Cleanup(func() { verifyDelay = prevDelay })
	proj := makeFlutterProject(t, "1.0.0+1")
	fakeBuild(t, func(dir string, _ []string) error {
		p := filepath.Join(dir, "build", "app", "outputs", "flutter-apk")
		_ = os.MkdirAll(p, 0o755)
		return os.WriteFile(filepath.Join(p, "app-release.apk"), []byte("apk"), 0o644)
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	routes := deployRoutes(&f, &committed, &listCalls, 1)
	created := false
	routes["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
	routes["POST /projects/prj_1/catalog/apps"] = func(r recorded) (int, any) {
		created = true
		if r.Body["name"] != "demo" || r.Body["path"] != "life.yyt.demo" {
			return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "body"}}
		}
		return 201, map[string]any{"id": "ca_1", "name": "demo", "path": "life.yyt.demo", "projectId": "prj_1", "createdAt": 1, "updatedAt": 1}
	}
	f = newFake(t, routes)
	withProject(t)
	if _, _, err := run(t, f, "catalog", "deploy", "--project-path", proj, "--no-verify"); err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("app was not created in the project")
	}
}

func TestDeployVerifyFails(t *testing.T) {
	prevDelay := verifyDelay
	verifyDelay = time.Millisecond
	t.Cleanup(func() { verifyDelay = prevDelay })
	proj := makeFlutterProject(t, "1.0.0+1")
	fakeBuild(t, func(dir string, _ []string) error {
		p := filepath.Join(dir, "build", "app", "outputs", "flutter-apk")
		_ = os.MkdirAll(p, 0o755)
		return os.WriteFile(filepath.Join(p, "app-release.apk"), []byte("apk"), 0o644)
	})
	var committed []map[string]any
	listCalls := 0
	var f *fakeConsole
	f = newFake(t, deployRoutes(&f, &committed, &listCalls, 99)) // never shows up
	withProject(t)
	_, _, err := run(t, f, "catalog", "deploy", "--project-path", proj)
	if err == nil || !strings.Contains(err.Error(), "verify") {
		t.Fatalf("expected verify failure, got %v", err)
	}
	if listCalls != 5 {
		t.Fatalf("expected 5 verify attempts, got %d", listCalls)
	}
}

func TestArtifactListFilter(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /catalog/apps/ca_1/artifacts": func(recorded) (int, any) {
			return 200, map[string]any{"artifacts": []any{
				map[string]any{"id": "art_1", "platform": "android", "url": "u",
					"tags": map[string]string{"version": "1.0.0", "stage": "beta"}, "createdAt": 1},
				map[string]any{"id": "art_2", "platform": "android", "url": "u",
					"tags": map[string]string{"version": "2.0.0", "stage": "beta"}, "createdAt": 1},
			}}
		},
	}, nil, []any{map[string]any{"id": "ca_1", "name": "demo"}}, nil))
	out, _, err := run(t, f, "catalog", "artifact", "list", "demo", "--filter", "version=2.0.0", "--filter", "stage=beta")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "art_1") || !strings.Contains(out, "art_2") {
		t.Fatalf("filter failed:\n%s", out)
	}
	if _, _, err := run(t, f, "catalog", "artifact", "list", "demo", "--filter", "oops"); err == nil {
		t.Fatal("expected invalid --filter error")
	}
}

func TestCatalogBumpStandalone(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	f := newFake(t, nil)
	out, _, err := run(t, f, "catalog", "bump", "--project-path", proj, "--bump", "minor")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "1.2.3+4 -> 1.3.0+5") {
		t.Fatalf("output:\n%s", out)
	}
	b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml"))
	if !strings.Contains(string(b), "version: 1.3.0+5") {
		t.Fatalf("pubspec not rewritten:\n%s", b)
	}
}

func TestTypedUploadAndroid(t *testing.T) {
	file := filepath.Join(t.TempDir(), "app.apk")
	_ = os.WriteFile(file, []byte("apk"), 0o644)
	var tags map[string]any
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /catalog/apps/ca_1/artifacts": func(r recorded) (int, any) {
			tags = r.Body["tags"].(map[string]any)
			if r.Body["platform"] != "android" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "platform"}}
			}
			return 201, map[string]any{"uploadId": "u1", "key": "k", "url": f.srv.URL + "/s3put",
				"method": "PUT", "headers": map[string]string{}, "expiresAt": 1}
		},
		"PUT /s3put": func(recorded) (int, any) { return 200, nil },
		"POST /catalog/uploads/u1/commit": func(recorded) (int, any) {
			return 200, map[string]any{"id": "art_1", "appId": "ca_1", "platform": "android",
				"url": "https://d/1", "tags": map[string]string{}, "createdAt": 1}
		},
	}, nil, []any{map[string]any{"id": "ca_1", "name": "demo"}}, nil))
	// missing required flags
	if _, _, err := run(t, f, "catalog", "artifact", "upload", "android", "demo", file, "--version", "1.0.0"); err == nil {
		t.Fatal("expected required-flag error")
	}
	out, _, err := run(t, f, "catalog", "artifact", "upload", "android", "demo", file,
		"--version", "1.0.0", "--application-id", "life.yyt.demo", "--build-type", "release",
		"--build", "7", "--abi", "arm64-v8a", "--stage", "beta", "--changelog", "fix")
	if err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"version": "1.0.0", "application_id": "life.yyt.demo", "build_type": "release",
		"build": "7", "abi": "arm64-v8a", "stage": "beta", "changelog": "fix",
	} {
		if tags[k] != want {
			t.Fatalf("tag %s = %v (want %s)", k, tags[k], want)
		}
	}
	if !strings.Contains(out, "art_1") {
		t.Fatalf("output:\n%s", out)
	}
}

func TestProfileLoginAndSwitch(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /me": func(recorded) (int, any) {
			return 200, map[string]any{"id": "m_1", "login": "octo", "role": "member", "via": "token"}
		},
	})
	cfg := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", cfg)
	t.Setenv("YYT_API", "")
	t.Setenv("YYT_TOKEN", "")
	t.Setenv("YYT_PROFILE", "")
	exec := func(args ...string) (string, error) {
		var out strings.Builder
		a := &App{Out: &out, Err: &out}
		root := NewRoot(a)
		root.SetArgs(args)
		err := root.Execute()
		return out.String(), err
	}
	if _, err := exec("login", "--profile", "dev", "--api", f.srv.URL, "--token", "yyt_dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("login", "--profile", "prod", "--api", f.srv.URL, "--token", "yyt_prod"); err != nil {
		t.Fatal(err)
	}
	out, err := exec("profile", "list")
	if err != nil || !strings.Contains(out, "dev") || !strings.Contains(out, "prod") {
		t.Fatalf("%v\n%s", err, out)
	}
	// default is the first stored profile; whoami uses it
	out, err = exec("whoami")
	if err != nil || !strings.Contains(out, "profile: dev") {
		t.Fatalf("%v\n%s", err, out)
	}
	// --profile switches; the fake sees the prod token
	if _, err = exec("--profile", "prod", "whoami"); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Auth != "Bearer yyt_prod" {
		t.Fatalf("auth %q", last.Auth)
	}
	if _, err := exec("profile", "use", "prod"); err != nil {
		t.Fatal(err)
	}
	out, err = exec("whoami")
	if err != nil || !strings.Contains(out, "profile: prod") {
		t.Fatalf("%v\n%s", err, out)
	}
	// unknown explicit profile fails fast
	if _, err := exec("--profile", "stage", "whoami"); err == nil ||
		!strings.Contains(err.Error(), "unknown profile") {
		t.Fatalf("expected unknown profile error, got %v", err)
	}
	// re-login to dev without --api must keep the dev API, not fall back to prod
	if _, err := exec("login", "--profile", "dev", "--token", "yyt_dev2"); err != nil {
		t.Fatal(err)
	}
	out, err = exec("profile", "list", "--json")
	if err != nil || !strings.Contains(out, f.srv.URL) {
		t.Fatalf("re-login lost the stored API: %v\n%s", err, out)
	}
	// `profile add` is a login under a fixed name; `cata` aliases `catalog`
	if _, err := exec("profile", "add", "stage", "--api", f.srv.URL, "--token", "yyt_stage"); err != nil {
		t.Fatal(err)
	}
	out, err = exec("--profile", "stage", "cata", "app", "list")
	if err == nil || !strings.Contains(err.Error(), "route not found") {
		// the fake has no /catalog/apps route; reaching it proves alias+profile work
		t.Fatalf("expected route-not-found via cata alias, got %v\n%s", err, out)
	}
	// `rm` aliases `remove`
	if _, err := exec("profile", "rm", "stage"); err != nil {
		t.Fatal(err)
	}
	// removing the default (prod) loses the marker; `profile default` restores it
	if _, err := exec("profile", "add", "stage", "--api", f.srv.URL, "--token", "yyt_stage"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("profile", "remove", "prod"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("profile", "default", "dev"); err != nil {
		t.Fatal(err)
	}
	out, err = exec("whoami")
	if err != nil || !strings.Contains(out, "profile: dev") {
		t.Fatalf("%v\n%s", err, out)
	}
	// rename moves the profile and the default marker; `ls` aliases `list`
	if _, err := exec("profile", "rename", "dev", "local"); err != nil {
		t.Fatal(err)
	}
	out, err = exec("profile", "ls")
	if err != nil || strings.Contains(out, "dev") || !strings.Contains(out, "local") {
		t.Fatalf("%v\n%s", err, out)
	}
	out, err = exec("whoami")
	if err != nil || !strings.Contains(out, "profile: local") {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := exec("profile", "rename", "local", "dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("login", "--profile", "prod", "--api", f.srv.URL, "--token", "yyt_prod"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("profile", "use", "prod"); err != nil {
		t.Fatal(err)
	}
	if _, err := exec("profile", "remove", "stage"); err != nil {
		t.Fatal(err)
	}
	// logout removes only the selected profile
	if _, err := exec("--profile", "dev", "logout"); err != nil {
		t.Fatal(err)
	}
	out, _ = exec("profile", "list")
	if strings.Contains(out, "dev") || !strings.Contains(out, "prod") {
		t.Fatalf("logout removed the wrong profile:\n%s", out)
	}
}

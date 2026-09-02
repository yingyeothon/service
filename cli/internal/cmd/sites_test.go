package cmd

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleSite = map[string]any{
	"id": "st_1", "name": "game-web", "slug": "k3x9q2mzp", "description": "browser client",
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"publicUrl": "https://dev-g.yyt.life/k3x9q2mzp/", "basePath": "/k3x9q2mzp/",
	"currentDeployId": "sd_01j5", "busy": false,
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

func sampleDeploy(id, status string, files int) map[string]any {
	var errVal any
	if status == "failed" {
		errVal = "zip_no_index_html"
	}
	return map[string]any{
		"id": id, "siteId": "st_1", "status": status, "zipBytes": 1234, "bytes": 5678, "files": files,
		"error": errVal, "createdBy": "m_octo", "createdAt": 1756000200, "updatedAt": 1756000260,
	}
}

func TestSiteListAndGet(t *testing.T) {
	detail := map[string]any{}
	for k, v := range sampleSite {
		detail[k] = v
	}
	detail["currentDeploy"] = sampleDeploy("sd_01j5", "live", 12)
	detail["deploys"] = []any{sampleDeploy("sd_01j6", "failed", 0), sampleDeploy("sd_01j5", "live", 12)}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /sites":                func(recorded) (int, any) { return 200, map[string]any{"sites": []any{sampleSite}} },
		"GET /projects/prj_1/sites": func(recorded) (int, any) { return 200, map[string]any{"sites": []any{sampleSite}} },
		"GET /sites/st_1":           func(recorded) (int, any) { return 200, detail },
		"GET /sites/st_1/deploys": func(recorded) (int, any) {
			return 200, map[string]any{"deploys": detail["deploys"]}
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "site", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_list", out)
	out, _, err = run(t, f, "site", "get", "game-web")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_get", out)
	out, _, err = run(t, f, "site", "deploys", "st_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_deploys", out)
	// A name needs a project; an id passes straight through.
	if !strings.HasPrefix(f.reqs[len(f.reqs)-1].Path, "/sites/st_1/deploys") {
		t.Fatalf("id was resolved instead of used: %s", f.reqs[len(f.reqs)-1].Path)
	}
}

func TestSiteDeployZipsAndPolls(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":          "<p>hi</p>",
		"assets/app-1.js":     "console.log(1)",
		".DS_Store":           "junk",
		"config.json":         `{"apiBase":"x"}`,
		"nested/.git/HEAD":    "ref",
		"nested/deep/x.txt":   "x",
		"assets/app-1.js.map": "{}",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var uploaded []byte
	polls := 0
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /sites/st_1/deploys": func(r recorded) (int, any) {
			if r.Body["size"] == nil {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "size"}}
			}
			return 201, map[string]any{
				"deployId": "sd_new", "url": f.srv.URL + "/s3put", "method": "PUT",
				"headers":   map[string]string{"content-type": "application/zip", "content-length": fmt.Sprint(r.Body["size"])},
				"expiresAt": 1756003600,
			}
		},
		"POST /sites/st_1/deploys/sd_new/commit": func(recorded) (int, any) { return 202, sampleDeploy("sd_new", "queued", 0) },
		"GET /sites/st_1/deploys/sd_new": func(recorded) (int, any) {
			polls++
			if polls < 2 {
				return 200, sampleDeploy("sd_new", "extracting", 0)
			}
			return 200, sampleDeploy("sd_new", "live", 4)
		},
		"GET /sites/st_1": func(recorded) (int, any) { return 200, sampleSite },
	}, nil, nil, nil))
	// The fake decodes JSON bodies only; wrap its handler to capture the raw PUT.
	inner := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/s3put" {
			uploaded, _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
			return
		}
		inner.ServeHTTP(w, r)
	})

	out, _, err := run(t, f, "site", "deploy", "st_1", dir, "--exclude", "*.map")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "live: https://dev-g.yyt.life/k3x9q2mzp/ (4 files") {
		t.Fatalf("output lacks the live URL:\n%s", out)
	}
	if polls != 2 {
		t.Fatalf("expected two polls, got %d", polls)
	}
	zr, err := zip.NewReader(bytes.NewReader(uploaded), int64(len(uploaded)))
	if err != nil {
		t.Fatalf("uploaded bytes are not a zip: %v", err)
	}
	var names []string
	for _, e := range zr.File {
		names = append(names, e.Name)
	}
	want := "assets/app-1.js config.json index.html nested/deep/x.txt"
	if strings.Join(names, " ") != want {
		t.Fatalf("zip entries %q, want %q", strings.Join(names, " "), want)
	}
	rc, _ := zr.File[2].Open()
	body, _ := io.ReadAll(rc)
	if string(body) != "<p>hi</p>" {
		t.Fatalf("index.html body %q", body)
	}
}

func TestSiteDeployReportsFailure(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /sites/st_1/deploys": func(r recorded) (int, any) {
			return 201, map[string]any{"deployId": "sd_bad", "url": f.srv.URL + "/s3put", "method": "PUT", "headers": map[string]string{}}
		},
		"PUT /s3put":                             func(recorded) (int, any) { return 200, nil },
		"POST /sites/st_1/deploys/sd_bad/commit": func(recorded) (int, any) { return 202, sampleDeploy("sd_bad", "queued", 0) },
		"GET /sites/st_1/deploys/sd_bad":         func(recorded) (int, any) { return 200, sampleDeploy("sd_bad", "failed", 0) },
	}, nil, nil, nil))
	_, _, err := run(t, f, "site", "deploy", "st_1", dir)
	if err == nil || !strings.Contains(err.Error(), "zip_no_index_html") {
		t.Fatalf("expected the failure code in the error, got %v", err)
	}
	// A zip file is uploaded as-is; anything else is refused before any request.
	if _, _, err := run(t, f, "site", "deploy", "st_1", filepath.Join(dir, "page.html")); err == nil || !strings.Contains(err.Error(), "neither a directory nor a .zip") {
		t.Fatalf("expected a refusal, got %v", err)
	}
}

func TestSiteUpdateRequiresAFlagAndClearsDescription(t *testing.T) {
	var sent map[string]any
	withProject(t)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /sites/st_1": func(r recorded) (int, any) {
			sent = r.Body
			return 200, sampleSite
		},
	}, nil, nil, nil))
	if _, _, err := run(t, f, "site", "update", "st_1"); err == nil {
		t.Fatal("expected an error when no field is given")
	}
	if _, _, err := run(t, f, "site", "update", "st_1", "--description", ""); err != nil {
		t.Fatal(err)
	}
	// An explicit empty --description clears the field rather than omitting it.
	v, ok := sent["description"]
	if !ok || v != nil {
		t.Fatalf("expected description:null, got %#v", sent)
	}
}

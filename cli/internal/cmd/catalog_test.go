package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleApp = map[string]any{
	"id": "ca_1", "name": "my-game", "path": "life.yyt.my-game", "description": "demo",
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

func TestCatalogAppListAndGet(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /catalog/apps": func(recorded) (int, any) {
			return 200, map[string]any{"apps": []any{sampleApp}}
		},
		"GET /catalog/apps/ca_1": func(recorded) (int, any) { return 200, sampleApp },
	}, nil, []any{sampleApp}, nil))
	// No context: the flat list across every team.
	out, _, err := run(t, f, "catalog", "app", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_app_list", out)
	if f.reqs[len(f.reqs)-1].Path != "/catalog/apps" {
		t.Fatalf("path %s", f.reqs[len(f.reqs)-1].Path)
	}
	// A name is resolved through the project (auto-selected for a read).
	out, _, err = run(t, f, "catalog", "app", "get", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_app_get", out)
	if last := f.reqs[len(f.reqs)-1].Path; last != "/catalog/apps/ca_1" {
		t.Fatalf("name must resolve to the id route, got %s", last)
	}
	// An id skips resolution entirely.
	f.reqs = nil
	if _, _, err := run(t, f, "catalog", "app", "get", "ca_1"); err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 1 {
		t.Fatalf("id lookup must be one request, got %d", len(f.reqs))
	}
}

func TestCatalogAppCreateSendsBody(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/catalog/apps": func(r recorded) (int, any) {
			if r.Body["name"] != "my-game" || r.Body["path"] != "life.yyt.my-game" || r.Body["description"] != "demo" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "body"}}
			}
			return 201, sampleApp
		},
	}, nil, nil, nil))
	if _, _, err := run(t, f, "catalog", "app", "create", "my-game", "--path", "life.yyt.my-game"); err == nil ||
		!strings.Contains(err.Error(), "no team context") {
		t.Fatalf("create must need an explicit context: %v", err)
	}
	if _, _, err := run(t, f, "catalog", "app", "create", "my-game", "--team", "dooroo", "--project", "game",
		"--path", "life.yyt.my-game", "--description", "demo"); err != nil {
		t.Fatal(err)
	}
}

func TestCatalogArtifactUploadFlow(t *testing.T) {
	file := filepath.Join(t.TempDir(), "app.zip")
	if err := os.WriteFile(file, []byte("binary!"), 0o644); err != nil {
		t.Fatal(err)
	}
	var putBody string
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /catalog/apps/ca_1/artifacts": func(r recorded) (int, any) {
			if r.Body["platform"] != "bin" || r.Body["filename"] != "app.zip" || r.Body["size"] != float64(7) {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "presign body"}}
			}
			tags := r.Body["tags"].(map[string]any)
			if tags["version"] != "1.0.0" || tags["stage"] != "beta" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "tags"}}
			}
			return 201, map[string]any{
				"uploadId": "u1", "key": "uploads/u1/app.zip",
				"url":    f.srv.URL + "/s3put",
				"method": "PUT",
				"headers": map[string]string{
					"content-type": "application/octet-stream", "content-length": "7",
				},
				"expiresAt": 1756003600,
			}
		},
		"PUT /s3put": func(r recorded) (int, any) {
			putBody = "yes"
			return 200, nil
		},
		"POST /catalog/uploads/u1/commit": func(recorded) (int, any) {
			return 200, map[string]any{
				"id": "art_1", "appId": "ca_1", "platform": "bin",
				"url":       "https://dev-d.yyt.life/my-game/u1/app.zip",
				"objectKey": "my-game/u1/app.zip", "size": 7, "hash": "h",
				"tags": map[string]string{"version": "1.0.0", "stage": "beta"}, "createdAt": 1756000200,
			}
		},
	}, nil, []any{sampleApp}, nil))
	out, _, err := run(t, f, "catalog", "artifact", "upload", "my-game", file,
		"--platform", "bin", "--version", "1.0.0", "--tag", "stage=beta")
	if err != nil {
		t.Fatal(err)
	}
	if putBody != "yes" {
		t.Fatal("presigned PUT was never sent")
	}
	if !strings.Contains(out, "https://dev-d.yyt.life/my-game/u1/app.zip") {
		t.Fatalf("output lacks the CDN URL:\n%s", out)
	}
}

// Groups and permissions are gone: team membership is the permission model.
func TestCatalogGroupAndPermissionRemoved(t *testing.T) {
	f := newFake(t, nil)
	for _, args := range [][]string{
		{"catalog", "group", "create", "g"},
		{"catalog", "permission", "list", "--app", "a"},
		{"catalog", "app", "create", "x", "--path", "p", "--debug-only"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Errorf("expected error for %v", args)
		}
	}
	if len(f.reqs) != 0 {
		t.Fatal("removed commands must not call the API")
	}
}

func TestCatalogCleanupDryRun(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /catalog/apps/ca_1/artifacts/cleanup": func(r recorded) (int, any) {
			if !strings.Contains(r.Path, "dryRun=true") {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "expected dryRun"}}
			}
			return 200, map[string]any{
				"dryRun": true,
				"preview": map[string]any{
					"keepRecentVersions": 2, "totalArtifacts": 3,
					"deletions": []any{map[string]any{
						"artifactId": "art_0", "platform": "android", "version": "0.9", "reason": "old_version",
					}},
				},
			}
		},
	}, nil, []any{sampleApp}, nil))
	out, _, err := run(t, f, "catalog", "app", "cleanup", "my-game", "--dry-run")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_cleanup_dry", out)
}

func TestDeviceLogin(t *testing.T) {
	polls := 0
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /auth/device/start": func(recorded) (int, any) {
			return 201, map[string]any{
				"handle": "dev_" + strings.Repeat("0", 32), "userCode": "AB-12",
				"verificationUri": "https://github.com/login/device",
				"intervalSec":     1, "expiresInSec": 30,
			}
		},
		"POST /auth/device/token": func(r recorded) (int, any) {
			polls++
			if polls == 1 {
				return 202, map[string]any{"status": "pending"}
			}
			if r.Body["tokenName"] != "test-box" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "tokenName"}}
			}
			return 201, map[string]any{
				"status": "ok", "token": "yyt_" + strings.Repeat("a", 48), "tokenId": "tok_1",
				"member": map[string]any{"id": "m_1", "login": "octo", "role": "member"},
			}
		},
	})
	out, errOut, err := run(t, f, "login", "--device", "--name", "test-box")
	if err != nil {
		t.Fatal(err)
	}
	if polls != 2 {
		t.Fatalf("expected 2 polls, got %d", polls)
	}
	if !strings.Contains(errOut, "AB-12") {
		t.Fatalf("user code not shown:\n%s", errOut)
	}
	if !strings.Contains(out, "logged in as octo (member)") {
		t.Fatalf("unexpected output:\n%s", out)
	}
}

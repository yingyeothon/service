package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleApp = map[string]any{
	"id": "ca_1", "name": "my-game", "path": "life.yyt.my-game", "debugOnly": false,
	"description": "demo", "groupId": nil, "ownerLogin": "octo", "pendingOwnerLogin": nil,
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

func TestCatalogAppListAndGet(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /catalog/apps": func(recorded) (int, any) {
			return 200, map[string]any{"apps": []any{sampleApp}}
		},
		"GET /catalog/apps/my-game": func(recorded) (int, any) { return 200, sampleApp },
	})
	out, _, err := run(t, f, "catalog", "app", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_app_list", out)
	out, _, err = run(t, f, "catalog", "app", "get", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_app_get", out)
}

func TestCatalogAppCreateSendsBody(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /catalog/apps": func(r recorded) (int, any) {
			if r.Body["name"] != "my-game" || r.Body["path"] != "life.yyt.my-game" || r.Body["debugOnly"] != true {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "body"}}
			}
			return 201, sampleApp
		},
	})
	if _, _, err := run(t, f, "catalog", "app", "create", "my-game",
		"--path", "life.yyt.my-game", "--debug-only"); err != nil {
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
	f = newFake(t, map[string]func(recorded) (int, any){
		"POST /catalog/apps/my-game/artifacts": func(r recorded) (int, any) {
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
	})
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

func TestCatalogPermissionFlagValidation(t *testing.T) {
	f := newFake(t, nil)
	if _, _, err := run(t, f, "catalog", "permission", "list"); err == nil {
		t.Fatal("expected an error without --app/--group")
	}
	if _, _, err := run(t, f, "catalog", "permission", "list", "--app", "a", "--group", "g"); err == nil {
		t.Fatal("expected an error with both --app and --group")
	}
}

func TestCatalogCleanupDryRun(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /catalog/apps/my-game/artifacts/cleanup": func(r recorded) (int, any) {
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
	})
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

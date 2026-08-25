package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleBundle = map[string]any{
	"id": "ab_1", "name": "dungeon-maps", "description": "MMO maps",
	"ownerLogin": "octo", "createdAt": 1756000000, "updatedAt": 1756000100,
}

func assetFileJSON(version, path string, size int) map[string]any {
	return map[string]any{
		"id": "af_" + path, "bundleId": "ab_1", "version": version, "path": path,
		"url":         "https://dev-d.yyt.life/assets/dungeon-maps/" + version + "/" + path,
		"objectKey":   "assets/dungeon-maps/" + version + "/" + path,
		"contentType": map[bool]string{true: "application/json", false: "image/png"}[strings.HasSuffix(path, ".json")],
		"size":        size, "createdAt": 1756000200,
	}
}

func TestAssetListAndGet(t *testing.T) {
	detail := map[string]any{}
	for k, v := range sampleBundle {
		detail[k] = v
	}
	detail["bytes"] = 96
	detail["versions"] = []any{
		map[string]any{"version": "v2", "files": 1, "bytes": 32, "createdAt": 1756000300},
		map[string]any{"version": "v1", "files": 2, "bytes": 64, "createdAt": 1756000200},
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /assets/bundles": func(recorded) (int, any) {
			return 200, map[string]any{"bundles": []any{sampleBundle}}
		},
		"GET /assets/bundles/dungeon-maps": func(recorded) (int, any) { return 200, detail },
	})
	out, _, err := run(t, f, "asset", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "asset_list", out)
	out, _, err = run(t, f, "asset", "get", "dungeon-maps")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "asset_get", out)
}

func TestAssetUploadFlow(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "map.json")
	if err := os.WriteFile(file, []byte(`{"w":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	var putType string
	var f *fakeConsole
	f = newFake(t, map[string]func(recorded) (int, any){
		"POST /assets/bundles/dungeon-maps/files": func(r recorded) (int, any) {
			if r.Body["version"] != "v1" || r.Body["path"] != "world/map.json" || r.Body["size"] != float64(7) {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "presign body"}}
			}
			return 201, map[string]any{
				"uploadId": "u1", "key": "asset-uploads/u1/world/map.json",
				"url": f.srv.URL + "/s3put", "method": "PUT",
				"headers":   map[string]string{"content-type": "application/json", "content-length": "7"},
				"expiresAt": 1756003600,
			}
		},
		"PUT /s3put": func(r recorded) (int, any) {
			putType = "sent"
			return 200, nil
		},
		"POST /assets/uploads/u1/commit": func(recorded) (int, any) {
			return 200, assetFileJSON("v1", "world/map.json", 7)
		},
	})
	out, _, err := run(t, f, "asset", "upload", "dungeon-maps", "v1", file, "--path", "world/map.json")
	if err != nil {
		t.Fatal(err)
	}
	if putType != "sent" {
		t.Fatal("presigned PUT was never sent")
	}
	if !strings.Contains(out, "https://dev-d.yyt.life/assets/dungeon-maps/v1/world/map.json") {
		t.Fatalf("output lacks the CDN URL:\n%s", out)
	}
}

func TestAssetPushWalksTheDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "art"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"map.json":      `{"w":1}`,
		"art/tiles.png": "png-bytes",
		".hidden":       "ignored",
	} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var uploaded []string
	var f *fakeConsole
	routes := map[string]func(recorded) (int, any){
		"POST /assets/bundles/maps/files": func(r recorded) (int, any) {
			p, _ := r.Body["path"].(string)
			uploaded = append(uploaded, p)
			return 201, map[string]any{
				"uploadId": fmt.Sprintf("u%d", len(uploaded)),
				"key":      "asset-uploads/x/" + p,
				"url":      f.srv.URL + "/s3put", "method": "PUT",
				"headers": map[string]string{"content-type": "application/json"},
			}
		},
		"PUT /s3put": func(recorded) (int, any) { return 200, nil },
	}
	// Commit answers with whatever the matching presign was told, in order.
	for i, p := range []string{"art/tiles.png", "map.json"} {
		p := p
		routes[fmt.Sprintf("POST /assets/uploads/u%d/commit", i+1)] = func(recorded) (int, any) {
			return 200, assetFileJSON("v1", p, 9)
		}
	}
	f = newFake(t, routes)
	if _, _, err := run(t, f, "asset", "push", "maps", "v1", dir); err != nil {
		t.Fatal(err)
	}
	// Sorted, slash-separated, relative to <dir>; dot-files are skipped so a
	// stray editor file never lands on the public CDN.
	if fmt.Sprint(uploaded) != "[art/tiles.png map.json]" {
		t.Fatalf("unexpected upload order/paths: %v", uploaded)
	}
}

func TestAssetUpdateRequiresAFlagAndClearsDescription(t *testing.T) {
	var sent map[string]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"PATCH /assets/bundles/dungeon-maps": func(r recorded) (int, any) {
			sent = r.Body
			return 200, sampleBundle
		},
	})
	if _, _, err := run(t, f, "asset", "update", "dungeon-maps"); err == nil {
		t.Fatal("expected an error when no field is given")
	}
	if _, _, err := run(t, f, "asset", "update", "dungeon-maps", "--description", ""); err != nil {
		t.Fatal(err)
	}
	// An explicit empty --description clears the field rather than omitting it.
	v, ok := sent["description"]
	if !ok || v != nil {
		t.Fatalf("expected description:null, got %#v", sent)
	}
}

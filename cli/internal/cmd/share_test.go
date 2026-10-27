package cmd

import (
	"strings"
	"testing"
)

func TestCatalogShareCreate(t *testing.T) {
	withProject(t)
	var post recorded
	full := false
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /catalog/apps/ca_1/share-links": func(r recorded) (int, any) {
			post = r
			if full {
				return 409, map[string]any{"error": map[string]any{
					"code": "conflict", "message": "too many live share links (max 20 per app)",
					"details": map[string]any{"limit": 20, "value": 20},
				}}
			}
			return 201, map[string]any{
				"id": "shl_1", "label": "playtest", "createdBy": "octo", "createdAt": 1756000000,
				"expiresAt": 1758592000, "revokedAt": nil, "live": true,
				"url": "https://console.example/i/shr_0123456789abcdef0123456789abcdef",
			}
		},
	}, nil, []any{sampleApp}, nil))
	out, errOut, err := run(t, f, "catalog", "share", "create", "my-game", "--days", "30", "--label", "  playtest  ")
	if err != nil {
		t.Fatal(err)
	}
	if out != "https://console.example/i/shr_0123456789abcdef0123456789abcdef\n" {
		t.Fatalf("out %q", out)
	}
	if !strings.Contains(errOut, "shl_1") || !strings.Contains(errOut, "not shown again") {
		t.Fatalf("stderr %q", errOut)
	}
	if post.Path != "/catalog/apps/ca_1/share-links" || post.Body["expiresInDays"] != float64(30) || post.Body["label"] != "playtest" {
		t.Fatalf("post %+v", post)
	}
	// Defaults: 7 days, no label key.
	if _, _, err := run(t, f, "catalog", "share", "create", "ca_1"); err != nil {
		t.Fatal(err)
	}
	if _, has := post.Body["label"]; has || post.Body["expiresInDays"] != float64(7) {
		t.Fatalf("defaults %v", post.Body)
	}
	// --json prints the whole object, url included.
	out, _, err = run(t, f, "catalog", "share", "create", "ca_1", "--json")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"url"`, `"expiresAt"`, `"live"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("--json lacks %s: %s", want, out)
		}
	}
	// Local validation costs no request.
	f.reqs = nil
	if _, _, err := run(t, f, "catalog", "share", "create", "ca_1", "--days", "3"); err == nil || !strings.Contains(err.Error(), "--days") {
		t.Fatalf("want days error, got %v", err)
	}
	if _, _, err := run(t, f, "catalog", "share", "create", "ca_1", "--label", strings.Repeat("x", 101)); err == nil || !strings.Contains(err.Error(), "--label") {
		t.Fatalf("want label error, got %v", err)
	}
	if _, _, err := run(t, f, "catalog", "share", "create", "ca_1", "--label", "a\x1bb"); err == nil || !strings.Contains(err.Error(), "control") {
		t.Fatalf("want control error, got %v", err)
	}
	if len(f.reqs) != 0 {
		t.Fatalf("validation must not call the console, got %d requests", len(f.reqs))
	}
	// The cap answer keeps the server's message and points at revoke.
	full = true
	_, _, err = run(t, f, "catalog", "share", "create", "ca_1")
	if err == nil || !strings.Contains(err.Error(), "too many live share links") || !strings.Contains(err.Error(), "share rm") {
		t.Fatalf("want conflict hint, got %v", err)
	}
}

func TestCatalogShareListRevokePublic(t *testing.T) {
	withProject(t)
	public := true
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /catalog/apps/ca_1/share-links": func(recorded) (int, any) {
			var pub any
			if public {
				pub = "https://console.example/i/ca_1"
			}
			return 200, map[string]any{
				"links": []any{
					map[string]any{"id": "shl_1", "label": "playtest", "createdBy": "octo", "createdAt": 1756000000, "expiresAt": 1756604800, "revokedAt": nil, "live": true},
					map[string]any{"id": "shl_2", "label": nil, "createdBy": nil, "createdAt": 1755000000, "expiresAt": 1755086400, "revokedAt": nil, "live": false},
					map[string]any{"id": "shl_3", "label": "old", "createdBy": "alice", "createdAt": 1756000000, "expiresAt": 1758592000, "revokedAt": 1756000500, "live": false},
				},
				"publicUrl": pub, "limit": 20,
			}
		},
		"DELETE /catalog/apps/ca_1/share-links/shl_1": func(recorded) (int, any) { return 204, nil },
	}, nil, []any{sampleApp}, nil))
	out, _, err := run(t, f, "catalog", "share", "ls", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_share_ls", out)
	out, _, err = run(t, f, "catalog", "share", "ls", "ca_1", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"limit"`) || !strings.Contains(out, `"publicUrl"`) {
		t.Fatalf("--json %s", out)
	}
	out, _, err = run(t, f, "catalog", "share", "public", "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	if out != "https://console.example/i/ca_1\n" {
		t.Fatalf("out %q", out)
	}
	out, _, err = run(t, f, "catalog", "share", "rm", "ca_1", "shl_1")
	if err != nil {
		t.Fatal(err)
	}
	if out != "revoked shl_1\n" {
		t.Fatalf("out %q", out)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/catalog/apps/ca_1/share-links/shl_1" {
		t.Fatalf("last %+v", last)
	}
	// Unknown id: the server's 404 surfaces.
	if _, _, err := run(t, f, "catalog", "share", "rm", "ca_1", "shl_9"); err == nil {
		t.Fatal("unknown link must fail")
	}
	// No public listing: no link line, and `public` explains the publish.
	public = false
	out, _, err = run(t, f, "catalog", "share", "ls", "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "public link") {
		t.Fatalf("out %q", out)
	}
	if _, _, err := run(t, f, "catalog", "share", "public", "ca_1"); err == nil || !strings.Contains(err.Error(), "--audience public") {
		t.Fatalf("want publish hint, got %v", err)
	}
	if _, _, err := run(t, f, "catalog", "share", "grant", "ca_1"); err == nil {
		t.Fatal("unknown share subcommand must fail")
	}
}

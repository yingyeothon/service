package cmd

import (
	"strings"
	"testing"
)

var sampleListing = map[string]any{
	"appId": "ca_1", "appName": "my-game", "teamId": "team_1", "teamName": "dooroo",
	"title": "My Game", "summary": "A game.", "tags": []string{"co-op", "rpg"}, "audience": "members",
	"publishedBy": "octo", "publishedAt": 1756000000, "updatedAt": 1756000100, "takenDown": false,
}

func TestCatalogPublishAndListing(t *testing.T) {
	withProject(t)
	var put recorded
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PUT /catalog/apps/ca_1/listing": func(r recorded) (int, any) {
			put = r
			return 201, sampleListing
		},
		"GET /catalog/apps/ca_1/listing": func(recorded) (int, any) {
			row := map[string]any{}
			for k, v := range sampleListing {
				row[k] = v
			}
			row["takenDown"] = true
			// A two-line summary shows its first line in the key/value view.
			row["summary"] = "A game.\nWith a second line."
			return 200, row
		},
		"DELETE /catalog/apps/ca_1/listing": func(recorded) (int, any) { return 204, nil },
	}, nil, []any{sampleApp}, nil))
	out, _, err := run(t, f, "catalog", "publish", "my-game",
		"--title", "My Game", "--summary", "A game.", "--tag", "rpg", "--tag", "co-op", "--audience", "members")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_publish", out)
	if put.Path != "/catalog/apps/ca_1/listing" {
		t.Fatalf("path %s", put.Path)
	}
	if put.Body["title"] != "My Game" || put.Body["audience"] != "members" || put.Body["summary"] != "A game." {
		t.Fatalf("body %v", put.Body)
	}
	if tags, _ := put.Body["tags"].([]any); len(tags) != 2 || tags[0] != "rpg" || tags[1] != "co-op" {
		t.Fatalf("tags %v", put.Body["tags"])
	}
	// No --summary: the key is absent, so the server keeps its rule; no
	// --tag: an empty list, because a publish replaces tags whole.
	if _, _, err := run(t, f, "catalog", "publish", "ca_1", "--title", "T"); err != nil {
		t.Fatal(err)
	}
	if _, has := put.Body["summary"]; has {
		t.Fatalf("summary must be absent, got %v", put.Body)
	}
	if tags, ok := put.Body["tags"].([]any); !ok || len(tags) != 0 {
		t.Fatalf("tags must be an empty list, got %v", put.Body["tags"])
	}
	if put.Body["audience"] != "public" {
		t.Fatalf("audience defaults to public, got %v", put.Body["audience"])
	}
	// An empty --summary clears it.
	if _, _, err := run(t, f, "catalog", "publish", "ca_1", "--title", "T", "--summary", ""); err != nil {
		t.Fatal(err)
	}
	if v, has := put.Body["summary"]; !has || v != nil {
		t.Fatalf("empty summary must be null, got %v", put.Body)
	}
	// Local validation costs no request.
	f.reqs = nil
	if _, _, err := run(t, f, "catalog", "publish", "ca_1", "--audience", "public"); err == nil || !strings.Contains(err.Error(), "--title") {
		t.Fatalf("want title error, got %v", err)
	}
	if _, _, err := run(t, f, "catalog", "publish", "ca_1", "--title", "T", "--audience", "everyone"); err == nil || !strings.Contains(err.Error(), "--audience") {
		t.Fatalf("want audience error, got %v", err)
	}
	if len(f.reqs) != 0 {
		t.Fatalf("validation must not call the console, got %d requests", len(f.reqs))
	}
	out, _, err = run(t, f, "catalog", "listing", "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_listing_taken_down", out)
	out, _, err = run(t, f, "catalog", "unpublish", "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	if out != "unpublished\n" {
		t.Fatalf("out %q", out)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/catalog/apps/ca_1/listing" {
		t.Fatalf("last %+v", last)
	}
}

func TestCatalogViewers(t *testing.T) {
	withProject(t)
	added := 0
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /catalog/apps/ca_1/listing/viewers": func(r recorded) (int, any) {
			added++
			if added == 1 {
				return 201, map[string]any{"login": "alice", "added": true}
			}
			return 200, map[string]any{"login": "alice", "added": false}
		},
		"DELETE /catalog/apps/ca_1/listing/viewers/alice": func(recorded) (int, any) { return 204, nil },
		"GET /catalog/apps/ca_1/listing/viewers": func(recorded) (int, any) {
			return 200, map[string]any{"viewers": []any{
				map[string]any{"login": "alice", "addedBy": "octo", "addedAt": 1756000000},
				map[string]any{"login": "bob", "addedBy": nil, "addedAt": 1756000100},
			}}
		},
	}, nil, []any{sampleApp}, nil))
	out, _, err := run(t, f, "catalog", "viewer", "add", "my-game", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	if out != "added alice\n" {
		t.Fatalf("out %q", out)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Body["login"] != "Alice" {
		t.Fatalf("login sent as typed, got %v", last.Body)
	}
	out, _, err = run(t, f, "catalog", "viewer", "add", "ca_1", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if out != "alice was already named\n" {
		t.Fatalf("out %q", out)
	}
	out, _, err = run(t, f, "catalog", "viewer", "ls", "ca_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_viewer_ls", out)
	out, _, err = run(t, f, "catalog", "viewer", "rm", "ca_1", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if out != "removed alice\n" {
		t.Fatalf("out %q", out)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/catalog/apps/ca_1/listing/viewers/alice" {
		t.Fatalf("last %+v", last)
	}
	// A removed grouping parent refuses an unknown verb instead of printing help.
	if _, _, err := run(t, f, "catalog", "viewer", "grant", "ca_1", "alice"); err == nil {
		t.Fatal("unknown viewer subcommand must fail")
	}
}

func TestCatalogListingsBrowse(t *testing.T) {
	var got string
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /catalog/listings": func(r recorded) (int, any) {
			got = r.Path
			return 200, map[string]any{"listings": []any{
				map[string]any{
					"appId": "ca_1", "appName": "my-game", "teamName": "dooroo", "title": "My Game",
					"summary": nil, "tags": []string{"rpg"}, "audience": "public",
					"publishedAt": 1756000000, "updatedAt": 1756000000,
					"artifacts": []any{
						map[string]any{"id": "art_a", "appId": "ca_1", "platform": "android", "url": "https://cdn.example/a.apk", "tags": map[string]any{"version": "1"}, "createdAt": 1756000000},
						map[string]any{"id": "art_i", "appId": "ca_1", "platform": "ios", "url": "https://cdn.example/a.ipa", "tags": map[string]any{"version": "1"}, "createdAt": 1755000000},
					},
					"latestArtifact": nil, "applicationIds": []any{},
				},
			}}
		},
	})
	// `--json` is the server's body, not a re-marshal: the fields the typed
	// table view does not carry survive, and nothing is added.
	jsonOut, _, err := run(t, f, "catalog", "listings", "--json")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"latestArtifact"`, `"applicationIds"`} {
		if !strings.Contains(jsonOut, want) {
			t.Fatalf("--json lacks %s: %s", want, jsonOut)
		}
	}
	if strings.Contains(jsonOut, "objectKey") {
		t.Fatalf("--json must not add objectKey: %s", jsonOut)
	}
	if _, _, err := run(t, f, "catalog", "listings", "--sort", "appName"); err == nil || !strings.Contains(err.Error(), "--sort") {
		t.Fatalf("want sort error, got %v", err)
	}
	out, _, err := run(t, f, "catalog", "listings", "--q", "game", "--tag", "rpg", "--platform", "android", "--sort", "title", "--order", "desc")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "catalog_listings", out)
	for _, want := range []string{"q=game", "tag=rpg", "platform=android", "sort=title", "order=desc"} {
		if !strings.Contains(got, want) {
			t.Fatalf("query %s lacks %s", got, want)
		}
	}
	// No flags: no query string, no context resolution (one request).
	f.reqs = nil
	if _, _, err := run(t, f, "catalog", "browse"); err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 1 || f.reqs[0].Path != "/catalog/listings" {
		t.Fatalf("reqs %+v", f.reqs)
	}
}

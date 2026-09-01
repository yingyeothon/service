package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

var sampleShow = map[string]any{
	"id": "sh_0123", "title": "Hackathon 36", "acl": "public", "eventId": nil,
	"createdBy": "octo", "createdAt": 1756000000, "updatedAt": 1756000100,
	"closedAt": nil, "bodyMd": "# come and look", "closedBy": nil,
	"entryCount": 2, "canWrite": true, "canManage": true,
	"grants": []map[string]any{
		{"login": "mate", "grantedBy": "octo", "grantedAt": 1756000050},
	},
}

var sampleEntry = map[string]any{
	"id": "se_0123", "showId": "sh_0123", "title": "Our game",
	"bodyMd": "played it all night", "createdBy": "mate",
	"createdAt": 1756000200, "updatedAt": 1756000300,
	"target": map[string]any{
		"kind": "site", "id": "st_1", "name": "web", "ref": nil,
		"available": true, "url": "https://g.example/abc/",
	},
	"shots": []map[string]any{
		{"id": "ss_1", "contentType": "image/png", "size": 12, "url": "https://console.example/shows/sh_0123/entries/se_0123/shots/ss_1"},
	},
	"likes": 3, "commentCount": 1, "liked": true,
	"comments": []map[string]any{
		{"id": "sc_1", "bodyMd": "nice", "createdBy": "octo", "createdAt": 1756000400, "updatedAt": 1756000400, "mine": false},
	},
	"canWrite": true, "canEdit": true, "canModerate": false, "canReact": true,
}

func TestShowListGetAndLifecycle(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /shows": func(recorded) (int, any) {
			return 200, map[string]any{"shows": []map[string]any{
				{"id": "sh_0123", "title": "Hackathon 36", "acl": "public", "eventId": nil, "createdBy": "octo", "createdAt": 1756000000, "updatedAt": 1756000100, "closedAt": nil},
				{"id": "sh_0456", "title": "Old wall", "acl": "member_only", "eventId": "ev_1", "createdBy": "mate", "createdAt": 1755000000, "updatedAt": 1755000100, "closedAt": 1755900000},
			}, "next": nil}
		},
		"GET /shows/sh_0123":        func(recorded) (int, any) { return 200, sampleShow },
		"POST /shows/sh_0123/close": func(recorded) (int, any) { return 204, nil },
		"DELETE /shows/sh_0123":     func(recorded) (int, any) { return 204, nil },
	})
	out, _, err := run(t, f, "show", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_list", out)
	out, _, err = run(t, f, "show", "get", "sh_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_get", out)
	if _, _, err = run(t, f, "show", "close", "sh_0123"); err != nil {
		t.Fatal(err)
	}
	// Deleting destroys other people's work, so the CLI refuses without a
	// reason rather than letting the API answer 400.
	if _, _, err = run(t, f, "show", "delete", "sh_0123"); err == nil ||
		!strings.Contains(err.Error(), "--reason is required") {
		t.Fatalf("want a local refusal, got %v", err)
	}
	if _, _, err = run(t, f, "show", "delete", "sh_0123", "--reason", "spam"); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Method != "DELETE" || last.Body["reason"] != "spam" {
		t.Fatalf("delete=%v", last)
	}
	// An unknown subcommand must fail, not print help and exit 0.
	if _, _, err = run(t, f, "show", "archive", "sh_0123"); err == nil {
		t.Fatal("unknown subcommand should fail")
	}
}

func TestShowEntriesAndComments(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /shows/sh_0123/entries": func(recorded) (int, any) {
			return 200, map[string]any{"entries": []map[string]any{sampleEntry}, "next": nil}
		},
		"GET /shows/sh_0123/entries/se_0123":         func(recorded) (int, any) { return 200, sampleEntry },
		"PUT /shows/sh_0123/entries/se_0123/like":    func(recorded) (int, any) { return 204, nil },
		"DELETE /shows/sh_0123/entries/se_0123/like": func(recorded) (int, any) { return 204, nil },
		"POST /shows/sh_0123/entries/se_0123/comments": func(recorded) (int, any) {
			return 201, map[string]any{"id": "sc_new"}
		},
	})
	out, _, err := run(t, f, "show", "entries", "list", "sh_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_entries_list", out)
	out, _, err = run(t, f, "show", "entries", "get", "sh_0123", "se_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_entry_get", out)
	for _, verb := range []string{"like", "unlike"} {
		if _, _, err = run(t, f, "show", "entries", verb, "sh_0123", "se_0123"); err != nil {
			t.Fatalf("%s: %v", verb, err)
		}
	}
	if _, _, err = run(t, f, "show", "entries", "comments", "add", "sh_0123", "se_0123", "--body", "nice"); err != nil {
		t.Fatal(err)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Body["bodyMd"] != "nice" {
		t.Fatalf("comment=%v", last)
	}
	// Exactly one of --app/--bundle/--site.
	if _, _, err = run(t, f, "show", "entries", "submit", "sh_0123", "t"); err == nil ||
		!strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("want a target refusal, got %v", err)
	}
	if _, _, err = run(t, f, "show", "entries", "submit", "sh_0123", "t", "--app", "a", "--site", "b"); err == nil {
		t.Fatal("two targets should fail")
	}
}

// The presigned PUT must never carry the console bearer: the URL already
// carries its own signature, and S3 is a different origin.
func TestShowScreenshotUploadCarriesNoBearer(t *testing.T) {
	var s3 []*http.Request
	obj := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		s3 = append(s3, r)
		w.WriteHeader(200)
	}))
	t.Cleanup(obj.Close)

	var committed map[string]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /shows/sh_0123/entries": func(recorded) (int, any) {
			return 201, map[string]any{"id": "se_0123"}
		},
		"POST /shows/sh_0123/entries/se_0123/shots": func(r recorded) (int, any) {
			// One presign call for the whole batch, never one per file.
			files, _ := r.Body["files"].([]any)
			grants := make([]map[string]any, 0, len(files))
			for i := range files {
				grants = append(grants, map[string]any{
					"id":      "ss_" + string(rune('a'+i)),
					"url":     obj.URL + "/put",
					"method":  "PUT",
					"headers": map[string]any{"content-type": "image/png"},
				})
			}
			return 200, map[string]any{"grants": grants, "expiresInSec": 600}
		},
		"PUT /shows/sh_0123/entries/se_0123/shots": func(r recorded) (int, any) {
			committed = r.Body
			return 204, nil
		},
		"GET /shows/sh_0123/entries/se_0123": func(recorded) (int, any) { return 200, sampleEntry },
		"GET /teams":                         func(recorded) (int, any) { return 200, map[string]any{"teams": []any{}} },
	})

	dir := t.TempDir()
	shot := filepath.Join(dir, "a.png")
	if err := os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "show", "entries", "submit", "sh_0123", "Our game",
		"--site", "st_1", "--screenshot", shot, "--screenshot", shot); err != nil {
		t.Fatal(err)
	}
	if len(s3) != 2 {
		t.Fatalf("want 2 uploads, got %d", len(s3))
	}
	for _, r := range s3 {
		if r.Header.Get("Authorization") != "" {
			t.Fatal("the presigned PUT must not carry the console bearer")
		}
		if r.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("signed content-type not sent verbatim: %q", r.Header.Get("Content-Type"))
		}
	}
	// The commit names screenshots by **id**; object keys never reach a client.
	ids, _ := committed["ids"].([]any)
	if len(ids) != 2 || ids[0] != "ss_a" || ids[1] != "ss_b" {
		t.Fatalf("commit=%v", committed)
	}
	if _, ok := committed["keys"]; ok {
		t.Fatal("the commit must not carry object keys")
	}
	// One presign for the batch: each one takes the caller's write slot.
	n := 0
	for _, r := range f.reqs {
		if r.Method == "POST" && strings.HasSuffix(r.Path, "/shots") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("want 1 presign call, got %d", n)
	}
}

func TestAuditListAndGet(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /admin/audit": func(recorded) (int, any) {
			return 200, map[string]any{"rows": []map[string]any{
				{"id": "au_1", "actor": "boss", "action": "show.delete", "target": "sh_0123", "at": 1756000500},
				{"id": "au_2", "actor": nil, "action": "show.sweep", "target": nil, "at": 1756000600},
			}, "next": nil}
		},
		"GET /admin/audit/au_1": func(recorded) (int, any) {
			return 200, map[string]any{
				"id": "au_1", "actor": "boss", "action": "show.delete", "target": "sh_0123",
				"at": 1756000500, "detail": `{"reason":"spam"}`, "detailTruncated": false,
			}
		},
	})
	out, _, err := run(t, f, "audit", "list", "--action-prefix", "show.")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "audit_list", out)
	if last := f.reqs[len(f.reqs)-1]; !strings.Contains(last.Path, "actionPrefix=show.") {
		t.Fatalf("filter not sent: %v", last.Path)
	}
	out, _, err = run(t, f, "audit", "get", "au_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "audit_get", out)
}

// The command tree is the CLI's contract; a silently dropped or renamed verb
// is what a golden over it catches.
func TestShowCommandTree(t *testing.T) {
	a := &App{}
	var walk func(c *cobra.Command, prefix string, out *[]string)
	walk = func(c *cobra.Command, prefix string, out *[]string) {
		for _, sub := range c.Commands() {
			name := strings.TrimSpace(prefix + " " + sub.Name())
			*out = append(*out, name)
			walk(sub, name, out)
		}
	}
	var lines []string
	for _, c := range NewRoot(a).Commands() {
		if c.Name() != "show" && c.Name() != "audit" {
			continue
		}
		lines = append(lines, c.Name())
		walk(c, c.Name(), &lines)
	}
	sort.Strings(lines)
	golden(t, "show_tree", strings.Join(lines, "\n")+"\n")
}

// Every nested group must error on an unknown subcommand rather than printing
// help and exiting 0 — a script still calling a removed verb would pass green.
func TestShowGroupsRejectUnknownSubcommands(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){})
	for _, args := range [][]string{
		{"show", "bogus"},
		{"show", "grants", "bogus", "sh_1"},
		{"show", "entries", "bogus", "sh_1"},
		{"show", "entries", "comments", "bogus", "sh_1", "se_1"},
		{"audit", "bogus"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Fatalf("%v should fail", args)
		}
	}
}

// A closed show, a gone target and a pinned build all render differently, and
// those branches are the point of decisions 5 and 6.
func TestShowRendersClosedAndUnavailable(t *testing.T) {
	closed := map[string]any{}
	for k, v := range sampleShow {
		closed[k] = v
	}
	closed["closedAt"] = 1756000900
	closed["closedBy"] = "boss"
	closed["acl"] = "member_only"
	closed["eventId"] = "ev_0123"

	gone := map[string]any{}
	for k, v := range sampleEntry {
		gone[k] = v
	}
	gone["target"] = map[string]any{
		"kind": "app", "id": "ca_1", "name": "game", "ref": "art_9",
		"available": false, "url": nil,
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /shows/sh_0123":                 func(recorded) (int, any) { return 200, closed },
		"GET /shows/sh_0123/entries/se_0123": func(recorded) (int, any) { return 200, gone },
		"GET /shows/sh_0123/entries": func(recorded) (int, any) {
			return 200, map[string]any{"entries": []map[string]any{gone}, "next": "CUR2"}
		},
	})
	out, _, err := run(t, f, "show", "get", "sh_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_get_closed", out)
	out, _, err = run(t, f, "show", "entries", "get", "sh_0123", "se_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "show_entry_get_gone", out)
	// A table run must say how to reach the next page, or `--cursor` is a flag
	// the caller can never feed.
	_, errOut, err := run(t, f, "show", "entries", "list", "sh_0123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut, "more: --cursor CUR2") {
		t.Fatalf("no paging hint: %q", errOut)
	}
}

// `--json` is the scripting contract, and `false` must not vanish.
func TestShowJSONKeepsFalseAndNext(t *testing.T) {
	entry := map[string]any{}
	for k, v := range sampleEntry {
		entry[k] = v
	}
	entry["canWrite"] = false
	entry["canEdit"] = false
	entry["canModerate"] = false
	entry["canReact"] = false
	entry["comments"] = []any{}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /shows/sh_0123/entries/se_0123": func(recorded) (int, any) { return 200, entry },
		"POST /shows/sh_0123/close":          func(recorded) (int, any) { return 204, nil },
		"GET /admin/audit": func(recorded) (int, any) {
			return 200, map[string]any{"rows": []map[string]any{}, "next": "CUR9"}
		},
	})
	out, _, err := run(t, f, "show", "entries", "get", "sh_0123", "se_0123", "--json")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"canWrite": false`, `"canEdit": false`, `"canModerate": false`, `"comments": []`} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %s in %s", want, out)
		}
	}
	// A mutation honours `--json` too; `output.Printer.KV` does not.
	out, _, err = run(t, f, "show", "close", "sh_0123", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"state": "closed"`) {
		t.Fatalf("close --json = %s", out)
	}
	// The audit cursor has to come back, or `--cursor` cannot be used.
	out, _, err = run(t, f, "audit", "list", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"next": "CUR9"`) {
		t.Fatalf("audit --json = %s", out)
	}
}

// The server's refusals must reach the caller intact, and the reason flags
// must actually travel.
func TestShowServerRefusalsAndReasons(t *testing.T) {
	var bodies []map[string]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /shows/sh_0123/entries": func(recorded) (int, any) {
			return 409, map[string]any{"error": map[string]any{"code": "conflict", "message": "show is closed"}}
		},
		"PATCH /shows/sh_0123/entries/se_0123": func(r recorded) (int, any) {
			bodies = append(bodies, r.Body)
			return 204, nil
		},
		"GET /shows/sh_0123/entries/se_0123": func(recorded) (int, any) { return 200, sampleEntry },
		"DELETE /shows/sh_0123/grants/mate": func(r recorded) (int, any) {
			bodies = append(bodies, r.Body)
			return 204, nil
		},
	})
	if _, _, err := run(t, f, "show", "entries", "submit", "sh_0123", "T", "--site", "st_1"); err == nil ||
		!strings.Contains(err.Error(), "show is closed") {
		t.Fatalf("want the server's refusal, got %v", err)
	}
	if _, _, err := run(t, f, "show", "entries", "update", "sh_0123", "se_0123",
		"--title", "moderated", "--reason", "off topic"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "show", "grants", "rm", "sh_0123", "mate", "--reason", "left the team"); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 || bodies[0]["reason"] != "off topic" || bodies[1]["reason"] != "left the team" {
		t.Fatalf("reasons did not travel: %v", bodies)
	}
	// A reason on its own is not an edit: it would spend a write slot and
	// record an audit row saying nothing changed.
	if _, _, err := run(t, f, "show", "entries", "update", "sh_0123", "se_0123", "--reason", "x"); err == nil ||
		!strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("want a local refusal, got %v", err)
	}
}

// A local, fully knowable error must not leave an entry on the wall: the
// target is unique per show, so re-running `submit` would be a 409.
func TestShowSubmitValidatesFilesBeforeCreating(t *testing.T) {
	posted := 0
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /shows/sh_0123/entries": func(recorded) (int, any) {
			posted++
			return 201, map[string]any{"id": "se_new"}
		},
	})
	for _, shot := range []string{"/definitely/missing.png", "notes.txt"} {
		if _, _, err := run(t, f, "show", "entries", "submit", "sh_0123", "T",
			"--site", "st_1", "--screenshot", shot); err == nil {
			t.Fatalf("%s should fail", shot)
		}
	}
	if posted != 0 {
		t.Fatalf("the entry was created before the files were checked (%d posts)", posted)
	}
}

// `--from`/`--to` go through `parseWhen`, and `--all` follows the cursor and
// stops.
func TestAuditFiltersAndPaging(t *testing.T) {
	page := 0
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /admin/audit": func(recorded) (int, any) {
			page++
			row := map[string]any{
				"id": "au_" + strconv.Itoa(page), "actor": "boss",
				"action": "show.create", "target": nil, "at": 1756000000,
			}
			if page < 3 {
				return 200, map[string]any{"rows": []map[string]any{row}, "next": "CUR" + strconv.Itoa(page)}
			}
			return 200, map[string]any{"rows": []map[string]any{row}, "next": nil}
		},
	})
	out, _, err := run(t, f, "audit", "list", "--all",
		"--from", "2026-09-01T00:00:00Z", "--to", "1756000000")
	if err != nil {
		t.Fatal(err)
	}
	if page != 3 || !strings.Contains(out, "au_3") {
		t.Fatalf("pages=%d out=%s", page, out)
	}
	q := f.reqs[0].Path
	if !strings.Contains(q, "from=1788220800") || !strings.Contains(q, "to=1756000000") {
		t.Fatalf("times not converted: %s", q)
	}
	if !strings.Contains(f.reqs[1].Path, "cursor=CUR1") {
		t.Fatalf("cursor not followed: %s", f.reqs[1].Path)
	}
}

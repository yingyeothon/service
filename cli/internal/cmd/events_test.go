package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleEvent = map[string]any{
	"id": "ev_0123", "title": "잉여톤 36", "status": "waiting", "bodyMd": "# hi",
	"place": "Seoul", "placeUrl": "https://map.example/x", "durationHours": 8,
	"voteUntil": 1756000000, "startsAt": 1756100000,
	"options": []map[string]any{
		{"id": "eo_1", "startsAt": 1756100000, "mine": true, "votes": 3},
		{"id": "eo_2", "startsAt": 1756200000, "mine": false, "votes": 1},
	},
	"voters": 3, "owner": "octo", "mine": false, "canEdit": false, "revision": 2,
	"createdAt": 1756000000, "updatedAt": 1756000100, "publishedAt": 1756000100,
	"posterUrl": "https://console.example/events/ev_0123/poster",
	"comments": []map[string]any{
		{"id": "ec_1", "bodyMd": "see you", "createdBy": "octo", "createdAt": 1756000200, "updatedAt": 1756000200, "mine": false},
	},
}

func TestEventsListGetAndLifecycle(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /events": func(recorded) (int, any) {
			return 200, map[string]any{"events": []map[string]any{
				{"id": "ev_0123", "title": "잉여톤 36", "status": "waiting", "place": "Seoul", "durationHours": 8, "voteUntil": 1756000000, "startsAt": 1756100000, "owner": "octo", "mine": false, "createdAt": 1756000000, "updatedAt": 1756000100, "publishedAt": 1756000100, "hasPoster": true},
				{"id": "ev_0456", "title": "draft one", "status": "draft", "place": "TBD", "durationHours": 4, "voteUntil": 1756000000, "startsAt": nil, "owner": "me", "mine": true, "createdAt": 1756000200, "updatedAt": 1756000200, "publishedAt": nil, "hasPoster": false},
			}}
		},
		"GET /events/ev_0123": func(recorded) (int, any) { return 200, sampleEvent },
		"POST /events/ev_0123/publish": func(recorded) (int, any) {
			return 409, map[string]any{"error": map[string]any{"code": "conflict", "message": "event is waiting"}}
		},
		"POST /events/ev_0123/cancel": func(recorded) (int, any) {
			e := map[string]any{}
			for k, v := range sampleEvent {
				e[k] = v
			}
			e["status"] = "cancelled"
			e["cancelledAt"] = 1756000300
			e["cancelledBy"] = "boss"
			return 200, e
		},
		"DELETE /events/ev_0123": func(recorded) (int, any) { return 204, nil },
	})
	out, _, err := run(t, f, "events", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "events_list", out)
	out, _, err = run(t, f, "events", "get", "ev_0123")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "events_get", out)
	if _, _, err = run(t, f, "events", "publish", "ev_0123"); err == nil || !strings.Contains(err.Error(), "event is waiting") {
		t.Fatalf("want conflict, got %v", err)
	}
	out, _, err = run(t, f, "events", "cancel", "ev_0123", "--json")
	if err != nil || !strings.Contains(out, `"status": "cancelled"`) {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if _, _, err = run(t, f, "events", "delete", "ev_0123"); err != nil {
		t.Fatal(err)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/events/ev_0123" {
		t.Fatalf("delete=%v", last)
	}
	// a removed subcommand must fail, not print help
	if _, _, err = run(t, f, "events", "transition", "ev_0123", "voting"); err == nil {
		t.Fatal("transition should be gone")
	}
}

func TestEventsCreateUpdateVote(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /events": func(r recorded) (int, any) {
			e := map[string]any{}
			for k, v := range sampleEvent {
				e[k] = v
			}
			e["id"] = "ev_new"
			e["status"] = "draft"
			e["title"] = r.Body["title"]
			return 201, e
		},
		"PATCH /events/ev_new": func(r recorded) (int, any) { return 200, sampleEvent },
		"PUT /events/ev_new/vote": func(r recorded) (int, any) {
			return 200, map[string]any{"eventId": "ev_new", "optionIds": r.Body["optionIds"]}
		},
		"DELETE /events/ev_new/vote": func(recorded) (int, any) { return 204, nil },
	})
	bodyFile := filepath.Join(t.TempDir(), "p.md")
	_ = os.WriteFile(bodyFile, []byte("from file"), 0o600)
	if _, _, err := run(t, f, "events", "create", "잉여톤 37", "--body", "@"+bodyFile, "--place", "Seoul", "--place-url", "https://map.example/y",
		"--hours", "8", "--vote-until", "2026-09-01T12:00:00+09:00", "--option", "2026-09-12T14:00:00+09:00", "--option", "1757746800"); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Body["title"] != "잉여톤 37" || last.Body["bodyMd"] != "from file" || last.Body["place"] != "Seoul" || last.Body["placeUrl"] != "https://map.example/y" {
		t.Fatalf("body=%v", last.Body)
	}
	// 2026-09-01T12:00+09:00 = 2026-09-01T03:00Z; 2026-09-12T14:00+09:00 = 2026-09-12T05:00Z
	if last.Body["durationHours"] != float64(8) || last.Body["voteUntil"] != float64(1788231600) {
		t.Fatalf("schedule=%v", last.Body)
	}
	opts, _ := last.Body["options"].([]any)
	if len(opts) != 2 || opts[0] != float64(1789189200) || opts[1] != float64(1757746800) {
		t.Fatalf("options=%v", last.Body["options"])
	}
	if _, _, err := run(t, f, "events", "create", "x", "--place", "p", "--hours", "1", "--vote-until", "yesterday", "--option", "1"); err == nil || !strings.Contains(err.Error(), "cannot parse time") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "events", "create", "x", "--hours", "1", "--vote-until", "1", "--option", "2"); err == nil || !strings.Contains(err.Error(), "place") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "events", "update", "ev_new"); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "events", "update", "ev_new", "--title", "New", "--clear-place-url", "--option", "2026-09-19T14:00:00+09:00"); err != nil {
		t.Fatal(err)
	}
	last = f.reqs[len(f.reqs)-1]
	if last.Method != "PATCH" || len(last.Body) != 3 || last.Body["title"] != "New" || last.Body["placeUrl"] != nil {
		t.Fatalf("patch=%v", last)
	}
	if _, ok := last.Body["placeUrl"]; !ok {
		t.Fatalf("placeUrl null missing: %v", last.Body)
	}
	out, _, err := run(t, f, "events", "vote", "ev_new", "eo_1", "eo_2")
	if err != nil || !strings.Contains(out, "eo_1 eo_2") {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if _, _, err = run(t, f, "events", "vote", "ev_new"); err == nil {
		t.Fatal("vote needs an option")
	}
	if _, _, err = run(t, f, "events", "unvote", "ev_new"); err != nil {
		t.Fatal(err)
	}
}

func TestEventsHistoryDiffComments(t *testing.T) {
	rev := func(n int, title, body string) map[string]any {
		return map[string]any{"revision": n, "editedBy": "octo", "editedAt": 1756000000 + int64(n), "title": title, "place": "Seoul", "placeUrl": nil, "durationHours": 8, "posterKey": nil, "bodyMd": body}
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /events/ev_1/revisions": func(recorded) (int, any) {
			return 200, map[string]any{"revisions": []map[string]any{rev(2, "after", ""), rev(1, "before", "")}}
		},
		"GET /events/ev_1/revisions/1": func(recorded) (int, any) { return 200, rev(1, "before", "line a\nline b\n") },
		"GET /events/ev_1/revisions/2": func(recorded) (int, any) { return 200, rev(2, "after", "line a\nline c\n") },
		"GET /events/ev_1":             func(recorded) (int, any) { return 200, sampleEvent },
		"POST /events/ev_1/comments": func(r recorded) (int, any) {
			return 201, map[string]any{"id": "ec_9", "bodyMd": r.Body["bodyMd"], "createdBy": "me", "createdAt": 1, "updatedAt": 1, "mine": true}
		},
		"PATCH /events/ev_1/comments/ec_9": func(r recorded) (int, any) {
			return 200, map[string]any{"id": "ec_9", "bodyMd": r.Body["bodyMd"], "createdBy": "me", "createdAt": 1, "updatedAt": 2, "mine": true}
		},
		"DELETE /events/ev_1/comments/ec_9": func(recorded) (int, any) { return 204, nil },
	})
	out, _, err := run(t, f, "events", "history", "ev_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "events_history", out)
	out, _, err = run(t, f, "events", "diff", "ev_1", "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "events_diff", out)
	out, _, err = run(t, f, "events", "diff", "ev_1", "1", "1")
	if err != nil || !strings.Contains(out, "(no changes)") {
		t.Fatalf("out=%s err=%v", out, err)
	}
	out, _, err = run(t, f, "events", "comments", "list", "ev_1")
	if err != nil || !strings.Contains(out, "see you") {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if _, _, err = run(t, f, "events", "comments", "add", "ev_1", "--body", "hi"); err != nil {
		t.Fatal(err)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Body["bodyMd"] != "hi" {
		t.Fatalf("add=%v", last)
	}
	if _, _, err = run(t, f, "events", "comments", "edit", "ev_1", "ec_9", "--body", "hey"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = run(t, f, "events", "comments", "delete", "ev_1", "ec_9"); err != nil {
		t.Fatal(err)
	}
	if last := f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/events/ev_1/comments/ec_9" {
		t.Fatalf("delete=%v", last)
	}
}

func TestDiffLines(t *testing.T) {
	ops := diffLines("a\nb\nc\n", "a\nc\nd\n")
	got := ""
	for _, o := range ops {
		got += o.Op + o.Line + "|"
	}
	if got != " a|-b| c|+d|" {
		t.Fatalf("got %q", got)
	}
	if len(diffLines("", "")) != 0 {
		t.Fatal("empty diff")
	}
	if u := unifiedDiff("r1", "r2", "x\n", "x\n"); !strings.Contains(u, "(no changes)") {
		t.Fatalf("u=%s", u)
	}
}

func TestPosterUpload(t *testing.T) {
	var got []byte
	var gotCT string
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Header.Get("Authorization") != "" {
			w.WriteHeader(403)
			return
		}
		got, _ = io.ReadAll(r.Body)
		gotCT = r.Header.Get("Content-Type")
		w.WriteHeader(200)
	}))
	defer s3.Close()
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /events/ev_1/poster": func(r recorded) (int, any) {
			if r.Body["contentType"] != "image/jpeg" || r.Body["size"] != float64(4) {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "bad presign request"}}
			}
			return 200, map[string]any{"key": "posters/ev_1/abc.jpg", "url": s3.URL + "/signed", "method": "PUT",
				"headers": map[string]string{"content-type": "image/jpeg", "content-length": "4"}, "expiresInSec": 600}
		},
		"POST /events/ev_1/poster/commit": func(r recorded) (int, any) {
			if r.Body["key"] != "posters/ev_1/abc.jpg" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "wrong key"}}
			}
			return 200, sampleEvent
		},
		"DELETE /events/ev_1/poster": func(recorded) (int, any) { return 204, nil },
		"GET /events/ev_1/posters": func(recorded) (int, any) {
			return 200, map[string]any{"posters": []map[string]any{
				{"id": "ep_2", "key": "posters/ev_1/abc.jpg", "contentType": "image/jpeg", "size": 4, "uploadedBy": "me", "uploadedAt": 2, "replacedAt": nil, "deletedAt": nil, "current": true},
				{"id": "ep_1", "key": "posters/ev_1/old.png", "contentType": "image/png", "size": 9, "uploadedBy": "octo", "uploadedAt": 1, "replacedAt": 2, "deletedAt": 2, "current": false},
			}}
		},
	})
	file := filepath.Join(t.TempDir(), "poster.JPG")
	_ = os.WriteFile(file, []byte("jpeg"), 0o600)
	out, _, err := run(t, f, "events", "poster", "upload", "ev_1", file)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "jpeg" || gotCT != "image/jpeg" || !strings.Contains(out, "poster") {
		t.Fatalf("got=%q ct=%q out=%s", got, gotCT, out)
	}
	if _, _, err = run(t, f, "events", "poster", "upload", "ev_1", "x.gif"); err == nil || !strings.Contains(err.Error(), ".png") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err = run(t, f, "events", "poster", "delete", "ev_1"); err != nil {
		t.Fatal(err)
	}
	out, _, err = run(t, f, "events", "poster", "history", "ev_1")
	if err != nil || !strings.Contains(out, "current") || !strings.Contains(out, "replaced") {
		t.Fatalf("out=%s err=%v", out, err)
	}
}

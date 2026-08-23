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
	"id": "ev_0123", "title": "잉여톤 12", "status": "published", "bodyMd": "# hi",
	"createdAt": 1756000000, "updatedAt": 1756000100, "publishedAt": 1756000100,
	"winner": map[string]any{"id": "pr_1", "eventId": "ev_0123", "memberLogin": "octo",
		"title": "Dungeon", "bodyMd": "b", "createdAt": 1756000000, "updatedAt": 1756000000, "mine": false, "votes": 3},
	"posterUrl": "https://console.example/events/ev_0123/poster",
}

func TestEventsListGetAndTransition(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /events": func(recorded) (int, any) {
			return 200, map[string]any{"events": []map[string]any{
				{"id": "ev_0123", "title": "잉여톤 12", "status": "published", "createdAt": 1756000000, "updatedAt": 1756000100, "publishedAt": 1756000100, "hasPoster": true},
				{"id": "ev_0456", "title": "draft one", "status": "draft", "createdAt": 1756000200, "updatedAt": 1756000200, "publishedAt": nil, "hasPoster": false},
			}}
		},
		"GET /events/ev_0123": func(recorded) (int, any) { return 200, sampleEvent },
		"POST /events/ev_0123/transition": func(r recorded) (int, any) {
			if r.Body["to"] != "closed" {
				return 409, map[string]any{"error": map[string]any{"code": "conflict", "message": "only published → closed is allowed"}}
			}
			e := map[string]any{}
			for k, v := range sampleEvent {
				e[k] = v
			}
			e["status"] = "closed"
			return 200, e
		},
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
	if _, _, err = run(t, f, "events", "transition", "ev_0123", "voting"); err == nil || !strings.Contains(err.Error(), "only published") {
		t.Fatalf("want conflict, got %v", err)
	}
	out, _, err = run(t, f, "events", "transition", "ev_0123", "closed", "--json")
	if err != nil || !strings.Contains(out, `"status": "closed"`) {
		t.Fatalf("out=%s err=%v", out, err)
	}
}

func TestProposalsAndVotes(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /events/ev_1/proposals": func(recorded) (int, any) {
			return 200, map[string]any{"proposals": []map[string]any{
				{"id": "pr_1", "eventId": "ev_1", "memberLogin": "octo", "title": "Dungeon", "bodyMd": "b", "createdAt": 1756000000, "updatedAt": 1756000000, "mine": true, "votes": 3},
				{"id": "pr_2", "eventId": "ev_1", "memberLogin": nil, "title": "Racing", "bodyMd": "b", "createdAt": 1756000001, "updatedAt": 1756000001, "mine": false, "votes": 1},
			}, "myVote": "pr_2"}
		},
		"POST /events/ev_1/proposals": func(r recorded) (int, any) {
			return 201, map[string]any{"id": "pr_9", "eventId": "ev_1", "memberLogin": "octo", "title": r.Body["title"], "bodyMd": r.Body["bodyMd"], "createdAt": 1756000000, "updatedAt": 1756000000, "mine": true}
		},
		"PUT /events/ev_1/vote": func(r recorded) (int, any) {
			return 200, map[string]any{"eventId": "ev_1", "proposalId": r.Body["proposalId"]}
		},
		"DELETE /events/ev_1/vote":           func(recorded) (int, any) { return 204, nil },
		"DELETE /events/ev_1/proposals/pr_9": func(recorded) (int, any) { return 204, nil },
		"PATCH /events/ev_1/proposals/pr_9": func(r recorded) (int, any) {
			return 200, map[string]any{"id": "pr_9", "eventId": "ev_1", "memberLogin": "octo", "title": r.Body["title"], "bodyMd": "from file", "createdAt": 1, "updatedAt": 2, "mine": true}
		},
	})
	out, _, err := run(t, f, "events", "proposals", "list", "ev_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "proposals_list", out)

	bodyFile := filepath.Join(t.TempDir(), "p.md")
	_ = os.WriteFile(bodyFile, []byte("from file"), 0o600)
	if _, _, err = run(t, f, "events", "proposals", "create", "ev_1", "Mine", "--body", "@"+bodyFile); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Body["title"] != "Mine" || last.Body["bodyMd"] != "from file" {
		t.Fatalf("body=%v", last.Body)
	}
	if _, _, err = run(t, f, "events", "proposals", "update", "ev_1", "pr_9"); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err = run(t, f, "events", "proposals", "update", "ev_1", "pr_9", "--title", "New"); err != nil {
		t.Fatal(err)
	}
	if last = f.reqs[len(f.reqs)-1]; last.Method != "PATCH" || len(last.Body) != 1 || last.Body["title"] != "New" {
		t.Fatalf("patch=%v", last)
	}
	if out, _, err = run(t, f, "events", "vote", "ev_1", "pr_2"); err != nil || !strings.Contains(out, "pr_2") {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if _, _, err = run(t, f, "events", "unvote", "ev_1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = run(t, f, "events", "proposals", "delete", "ev_1", "pr_9"); err != nil {
		t.Fatal(err)
	}
	if last = f.reqs[len(f.reqs)-1]; last.Method != "DELETE" || last.Path != "/events/ev_1/proposals/pr_9" {
		t.Fatalf("delete=%v", last)
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
}

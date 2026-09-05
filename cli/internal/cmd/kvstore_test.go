package cmd

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleKv = map[string]any{
	"id": "kv_01j5abcdefghjkmnpqrstvwxyz", "name": "profiles", "readScope": "project", "writeScope": "user",
	"encrypted": false, "maxEntries": 10000, "maxEntriesPerOwner": 100, "entries": 2,
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

func sampleKvDetail() map[string]any {
	d := map[string]any{}
	for k, v := range sampleKv {
		d[k] = v
	}
	d["description"] = "public profiles"
	d["api"] = map[string]any{
		"configured": true, "baseUrl": "https://doc-dev.yyt.life",
		"metaPath": "/kv/kv_01j5abcdefghjkmnpqrstvwxyz", "entriesPath": "/kv/kv_01j5abcdefghjkmnpqrstvwxyz/entries",
		"ownerPath": "/kv/kv_01j5abcdefghjkmnpqrstvwxyz/u/{ownerId}/entries",
	}
	return d
}

func kvEntryRow(owner, key string, version int, value any) map[string]any {
	e := map[string]any{
		"owner": owner, "key": key, "version": version, "bytes": 11, "expiresAt": nil,
		"channelId": "auth_1", "updatedAt": 1756000200,
	}
	if value != nil {
		e["valueText"] = value
	}
	return e
}

const kvID = "kv_01j5abcdefghjkmnpqrstvwxyz"

func TestKvListGetAndCreate(t *testing.T) {
	withProject(t)
	var created map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1/kv": func(recorded) (int, any) { return 200, map[string]any{"collections": []any{sampleKv}} },
		"GET /kv/" + kvID:        func(recorded) (int, any) { return 200, sampleKvDetail() },
		"POST /projects/prj_1/kv": func(r recorded) (int, any) {
			created = r.Body
			return 201, sampleKvDetail()
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "kv", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "kv_list", out)
	// A name resolves through the project's list; the detail is then by id.
	out, _, err = run(t, f, "kv", "get", "Profiles")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "kv_get", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/kv/"+kvID {
		t.Fatalf("detail path %s", got)
	}

	// A scope the console would refuse is refused here, before any request.
	n := len(f.reqs)
	if _, _, err := run(t, f, "kv", "create", "x", "--read", "public", "--write", "user"); err == nil || !strings.Contains(err.Error(), "team, project, user") {
		t.Fatalf("bad scope accepted: %v", err)
	}
	if len(f.reqs) != n {
		t.Fatalf("a request was made for a bad scope")
	}
	out, _, err = run(t, f, "kv", "create", "profiles", "--read", "project", "--write", "user", "--encrypted", "--max-entries-per-owner", "5", "--description", "public profiles")
	if err != nil {
		t.Fatal(err)
	}
	// The defaults are the server's: only the changed cap travels.
	want := map[string]any{"name": "profiles", "readScope": "project", "writeScope": "user", "encrypted": true, "maxEntriesPerOwner": float64(5), "description": "public profiles"}
	if len(created) != len(want) {
		t.Fatalf("create body %v", created)
	}
	for k, v := range want {
		if created[k] != v {
			t.Fatalf("create body[%s] = %v, want %v", k, created[k], v)
		}
	}
	if !strings.Contains(out, "apiOwner") {
		t.Fatalf("create output lacks the api block:\n%s", out)
	}
}

func TestKvUpdateSendsOnlyTheGivenFields(t *testing.T) {
	var patched map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /kv/" + kvID: func(r recorded) (int, any) {
			patched = r.Body
			return 200, sampleKvDetail()
		},
	}, nil, nil, nil))
	if _, _, err := run(t, f, "kv", "update", kvID); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("empty update accepted: %v", err)
	}
	if _, _, err := run(t, f, "kv", "update", kvID, "--max-entries", "500", "--description", ""); err != nil {
		t.Fatal(err)
	}
	if patched["maxEntries"] != float64(500) || patched["description"] != nil || len(patched) != 2 {
		t.Fatalf("patch body %v", patched)
	}
	if _, ok := patched["description"]; !ok {
		t.Fatalf("an explicit empty --description must travel as null: %v", patched)
	}
}

func TestKvEntriesFollowsTheCursor(t *testing.T) {
	pages := 0
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /kv/" + kvID + "/entries": func(r recorded) (int, any) {
			pages++
			if strings.Contains(r.Path, "cursor=c1") {
				return 200, map[string]any{"entries": []any{kvEntryRow("b", "profile", 1, "null")}}
			}
			return 200, map[string]any{
				"entries":    []any{kvEntryRow("a", "profile", 3, `{"name":"A"}`), kvEntryRow("a", "settings", 2, nil), kvEntryRow("a", "long", 1, `{"pad":"`+strings.Repeat("x", 80)+`"}`)},
				"nextCursor": "c1",
			}
		},
	}, nil, nil, nil))
	out, errOut, err := run(t, f, "kv", "entries", kvID, "--owner", "a", "--prefix", "p")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.reqs[0].Path, "owner=a") || !strings.Contains(f.reqs[0].Path, "prefix=p") {
		t.Fatalf("filters missing from %s", f.reqs[0].Path)
	}
	if !strings.Contains(errOut, "--cursor c1") {
		t.Fatalf("next cursor not reported: %q", errOut)
	}
	golden(t, "kv_entries", out)
	pages = 0
	out, errOut, err = run(t, f, "kv", "entries", kvID, "--all")
	if err != nil {
		t.Fatal(err)
	}
	if pages != 2 || errOut != "" || !strings.Contains(out, "null") {
		t.Fatalf("--all: pages=%d err=%q out=\n%s", pages, errOut, out)
	}
}

func TestKvEntryPutGetDelete(t *testing.T) {
	var put map[string]any
	var putPath string
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PUT /kv/" + kvID + "/entries/profile": func(r recorded) (int, any) {
			put, putPath = r.Body, r.Path
			return 201, map[string]any{"owner": "a", "key": "profile", "version": 1, "bytes": 12, "created": true}
		},
		"GET /kv/" + kvID + "/entries/profile": func(r recorded) (int, any) {
			if strings.Contains(r.Path, "owner=sealed") {
				return 200, kvEntryRow("sealed", "profile", 1, nil)
			}
			return 200, kvEntryRow("a", "profile", 1, `{"name":"A"}`)
		},
		"DELETE /kv/" + kvID + "/entries/profile": func(recorded) (int, any) { return 204, nil },
	}, nil, nil, nil))

	// Not JSON: refused before any request.
	n := len(f.reqs)
	if _, _, err := run(t, f, "kv", "entry", "put", kvID, "profile", "--value", "{oops"); err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("bad JSON accepted: %v", err)
	}
	if _, _, err := run(t, f, "kv", "entry", "put", kvID, "profile", "--value", "1", "--file", "x"); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("--value with --file accepted: %v", err)
	}
	if len(f.reqs) != n {
		t.Fatalf("a request was made for a refused put")
	}

	// A stale --if-version is a 409 that names the winner (exit code 2).
	conflicts := true
	f.srv.Config.Handler = wrapConflict(f.srv.Config.Handler, "/kv/"+kvID+"/entries/profile", &conflicts)
	_, errOut, err := run(t, f, "kv", "entry", "put", kvID, "profile", "--owner", "a", "--value", "1", "--if-version", "1")
	if err == nil || !strings.Contains(err.Error(), "version mismatch") || !strings.Contains(err.Error(), `"current":2`) {
		t.Fatalf("stale put: err=%v stderr=%q", err, errOut)
	}
	conflicts = false

	out, _, err := run(t, f, "kv", "entry", "put", kvID, "profile", "--owner", "a", "--value", `{"name":"A"}`, "--ttl", "60", "--if-version", "3")
	if err != nil {
		t.Fatal(err)
	}
	if put["valueText"] != `{"name":"A"}` || put["owner"] != "a" || put["ttl"] != float64(60) || put["ifVersion"] != float64(3) {
		t.Fatalf("put body %v", put)
	}
	if strings.Contains(putPath, "owner=") {
		t.Fatalf("the owner travels in the body, not the query: %s", putPath)
	}
	if out != "created profile (version 1, 12 bytes)\n" {
		t.Fatalf("put output %q", out)
	}

	// --file and stdin are the other two sources, verbatim.
	p := filepath.Join(t.TempDir(), "v.json")
	if err := os.WriteFile(p, []byte("[1, 2]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "kv", "entry", "put", kvID, "profile", "--file", p); err != nil {
		t.Fatal(err)
	}
	if put["valueText"] != "[1, 2]\n" || put["ttl"] != nil {
		t.Fatalf("file put body %v", put)
	}
	out, _, err = runIn(t, f, strings.NewReader(`"from stdin"`), "kv", "entry", "put", kvID, "profile")
	if err != nil {
		t.Fatal(err)
	}
	if put["valueText"] != `"from stdin"` {
		t.Fatalf("stdin put body %v", put)
	}
	if _, _, err := runIn(t, f, strings.NewReader(""), "kv", "entry", "put", kvID, "profile"); err == nil || !strings.Contains(err.Error(), "no value") {
		t.Fatalf("empty stdin accepted: %v", err)
	}

	// get prints the value byte for byte, no trailing newline, and the
	// envelope only with --json; an unreadable value says so.
	out, _, err = run(t, f, "kv", "entry", "get", kvID, "profile", "--owner", "a")
	if err != nil {
		t.Fatal(err)
	}
	if out != `{"name":"A"}` {
		t.Fatalf("get output %q", out)
	}
	if !strings.HasSuffix(f.reqs[len(f.reqs)-1].Path, "/entries/profile?owner=a") {
		t.Fatalf("get path %s", f.reqs[len(f.reqs)-1].Path)
	}
	out, _, err = run(t, f, "kv", "entry", "get", kvID, "profile", "--owner", "sealed")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "(not readable here)") || strings.Contains(out, "name") {
		t.Fatalf("sealed get output %q", out)
	}
	out, _, err = run(t, f, "--json", "kv", "entry", "get", kvID, "profile", "--owner", "a")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"version": 1`) {
		t.Fatalf("json get output %q", out)
	}

	out, _, err = run(t, f, "kv", "entry", "rm", kvID, "profile", "--owner", "a")
	if err != nil {
		t.Fatal(err)
	}
	if out != "deleted profile\n" || !strings.HasSuffix(f.reqs[len(f.reqs)-1].Path, "/entries/profile?owner=a") {
		t.Fatalf("delete: %q %s", out, f.reqs[len(f.reqs)-1].Path)
	}
}

func TestKvEntryClearRepeatsWhileTruncated(t *testing.T) {
	calls := 0
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"DELETE /kv/" + kvID + "/entries": func(r recorded) (int, any) {
			calls++
			if !strings.HasSuffix(r.Path, "?owner=a") && strings.Contains(r.Path, "?") {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "owner"}}
			}
			return 200, map[string]any{"deleted": 1000, "truncated": calls < 3}
		},
	}, nil, nil, nil))
	// No owner: the shared namespace, and no `?owner=` in the query.
	out, _, err := run(t, f, "kv", "entry", "clear", kvID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.reqs[len(f.reqs)-1].Path, "owner") || out != "deleted 3000 entries\n" {
		t.Fatalf("shared clear: %q %s", out, f.reqs[len(f.reqs)-1].Path)
	}
	calls = 0
	out, _, err = run(t, f, "kv", "entry", "clear", kvID, "--owner", "a")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 || out != "deleted 3000 entries of a\n" {
		t.Fatalf("calls=%d out=%q", calls, out)
	}
}

// wrapConflict answers PUT <path> with a compare-and-set 409 while *on.
func wrapConflict(inner http.Handler, path string, on *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if *on && r.Method == http.MethodPut && r.URL.Path == path {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"version mismatch","details":{"current":2}}}`))
			return
		}
		inner.ServeHTTP(w, r)
	})
}

// runIn is `run` with a stdin.
func runIn(t *testing.T, f *fakeConsole, in *strings.Reader, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	cfg := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", cfg)
	t.Setenv("YYT_API", f.srv.URL)
	t.Setenv("YYT_TOKEN", "yyt_test")
	var out, errb bytes.Buffer
	a := &App{Out: &out, Err: &errb, In: in}
	root := NewRoot(a)
	root.SetArgs(args)
	err = root.Execute()
	return out.String(), errb.String(), err
}

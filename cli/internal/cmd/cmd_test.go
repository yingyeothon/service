package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/selfupdate"
)

var update = flag.Bool("update", false, "rewrite golden files")

// TestMain strips the developer's own context so tests see only what they set.
func TestMain(m *testing.M) {
	flag.Parse()
	for _, k := range []string{"YYT_TEAM", "YYT_PROJECT", "YYT_PROFILE"} {
		_ = os.Unsetenv(k)
	}
	os.Exit(m.Run())
}

// Context fixtures: one team `dooroo` (team_1) with one project `game` (prj_1).
var sampleTeam = map[string]any{
	"id": "team_1", "name": "dooroo", "role": "owner", "description": "the studio",
	"adminLocked": false, "createdBy": "octo", "createdAt": 1756000000, "updatedAt": 1756000100,
}

var sampleProject = map[string]any{
	"id": "prj_1", "teamId": "team_1", "teamName": "dooroo", "name": "game",
	"description": nil, "createdBy": "octo", "createdAt": 1756000000, "updatedAt": 1756000100,
}

// ctxRoutes adds the routes context resolution walks (teams → projects →
// per-project resource lists) to a route table. Callers pass the resources
// the project holds; nil lists answer empty.
func ctxRoutes(routes map[string]func(recorded) (int, any), channels, apps, bundles []any) map[string]func(recorded) (int, any) {
	if routes == nil {
		routes = map[string]func(recorded) (int, any){}
	}
	list := func(key string, items []any) func(recorded) (int, any) {
		if items == nil {
			items = []any{}
		}
		return func(recorded) (int, any) { return 200, map[string]any{key: items} }
	}
	defaults := map[string]func(recorded) (int, any){
		"GET /teams":                         list("teams", []any{sampleTeam}),
		"GET /teams/team_1":                  func(recorded) (int, any) { return 200, sampleTeam },
		"GET /teams/team_1/projects":         list("projects", []any{sampleProject}),
		"GET /projects/prj_1":                func(recorded) (int, any) { return 200, sampleProject },
		"GET /projects/prj_1/channels":       list("channels", channels),
		"GET /projects/prj_1/catalog/apps":   list("apps", apps),
		"GET /teams/team_1/catalog/apps":     list("apps", apps),
		"GET /projects/prj_1/assets/bundles": list("bundles", bundles),
		"GET /projects/prj_1/sites":          list("sites", nil),
	}
	for k, h := range defaults {
		if _, own := routes[k]; !own { // a test's own route wins
			routes[k] = h
		}
	}
	return routes
}

// withProject pins the project context by id for the test (what a script
// with YYT_PROJECT or .yyt.json does).
func withProject(t *testing.T) {
	t.Helper()
	t.Setenv("YYT_PROJECT", "prj_1")
}

// fakeConsole records requests and answers from a route table.
type fakeConsole struct {
	t    *testing.T
	reqs []recorded
	srv  *httptest.Server
}

type recorded struct {
	Method, Path, Auth string
	Body               map[string]any
}

func newFake(t *testing.T, routes map[string]func(r recorded) (int, any)) *fakeConsole {
	f := &fakeConsole{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := recorded{Method: r.Method, Path: r.URL.RequestURI(), Auth: r.Header.Get("Authorization")}
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &rec.Body)
		}
		f.reqs = append(f.reqs, rec)
		h, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"route not found"}}`))
			return
		}
		status, body := h(rec)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// run executes the CLI against the fake with a logged-in config.
func run(t *testing.T, f *fakeConsole, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	cfg := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", cfg)
	t.Setenv("YYT_API", f.srv.URL)
	t.Setenv("YYT_TOKEN", "yyt_test")
	var out, errb bytes.Buffer
	a := &App{Out: &out, Err: &errb}
	root := NewRoot(a)
	root.SetArgs(args)
	err = root.Execute()
	return out.String(), errb.String(), err
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", name+".golden")
	if *update {
		_ = os.WriteFile(p, []byte(got), 0o644)
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", p, err)
	}
	if string(want) != got {
		t.Errorf("golden %s mismatch\n--- want\n%s--- got\n%s", name, want, got)
	}
}

var sampleChannel = map[string]any{
	"id": "auth_0123", "kind": "auth", "name": "demo",
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"config":    map[string]any{"audience": "demo", "tokenTtlSec": 86400, "redirectAllowlist": []string{}, "providers": map[string]any{}},
	"createdAt": 1756000000, "expiresAt": 1756604800, "disabledAt": nil, "status": "active",
	"issuer": "yyt-auth/auth_0123", "startUrl": "https://auth.example/c/auth_0123/start",
	"callbackUrls": map[string]string{"github": "https://auth.example/c/auth_0123/github/callback"},
}

func TestWhoamiTableAndJSON(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /me": func(r recorded) (int, any) {
			if r.Auth != "Bearer yyt_test" {
				return 401, map[string]any{"error": map[string]any{"code": "unauthorized", "message": "no"}}
			}
			return 200, map[string]any{"id": "m_1", "login": "octo", "role": "member", "via": "token"}
		},
	})
	out, _, err := run(t, f, "whoami")
	if err != nil {
		t.Fatal(err)
	}
	out = strings.ReplaceAll(out, f.srv.URL, "<api>")
	golden(t, "whoami", out)
	out, _, err = run(t, f, "whoami", "--json")
	if err != nil {
		t.Fatal(err)
	}
	out = strings.ReplaceAll(out, f.srv.URL, "<api>")
	golden(t, "whoami_json", out)
}

func TestNotLoggedIn(t *testing.T) {
	f := newFake(t, nil)
	t.Setenv("YYT_CONFIG", filepath.Join(t.TempDir(), "c.json"))
	t.Setenv("YYT_TOKEN", "")
	var out bytes.Buffer
	root := NewRoot(&App{Out: &out, Err: &out})
	root.SetArgs([]string{"whoami", "--api", f.srv.URL})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("err=%v", err)
	}
	if len(f.reqs) != 0 {
		t.Fatal("must not call the API without a token")
	}
}

func TestLoginVerifiesAndSaves(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /me": func(r recorded) (int, any) {
			if r.Auth != "Bearer yyt_new" {
				return 401, map[string]any{"error": map[string]any{"code": "unauthorized", "message": "bad token"}}
			}
			return 200, map[string]any{"id": "m_1", "login": "octo", "role": "pending", "via": "token"}
		},
	})
	cfg := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", cfg)
	t.Setenv("YYT_TOKEN", "")
	t.Setenv("YYT_API", "")
	var out bytes.Buffer
	root := NewRoot(&App{Out: &out, Err: &out})
	root.SetArgs([]string{"login", "--token", "bad", "--api", f.srv.URL})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "token rejected") {
		t.Fatalf("err=%v", err)
	}
	if _, err := os.Stat(cfg); err == nil {
		t.Fatal("config must not be written for a rejected token")
	}
	root = NewRoot(&App{Out: &out, Err: &out})
	root.SetArgs([]string{"login", "--token", "yyt_new", "--api", f.srv.URL})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(cfg)
	if !strings.Contains(string(b), `"token": "yyt_new"`) {
		t.Fatalf("config: %s", b)
	}
	if !strings.Contains(out.String(), "logged in as octo (pending)") {
		t.Fatalf("out: %s", out.String())
	}
	// Plain http to a non-localhost host is refused.
	root = NewRoot(&App{Out: &out, Err: &out})
	root.SetArgs([]string{"login", "--token", "x", "--api", "http://example.com"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("err=%v", err)
	}
	// Token on stdin.
	cfg2 := filepath.Join(t.TempDir(), "c2.json")
	t.Setenv("YYT_CONFIG", cfg2)
	root = NewRoot(&App{Out: &out, Err: &out})
	root.SetIn(strings.NewReader("yyt_new\n"))
	root.SetArgs([]string{"login", "--api", f.srv.URL})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg2); err != nil {
		t.Fatal("config not written from stdin token")
	}
}

func TestPlainHTTPRefusedEverywhere(t *testing.T) {
	t.Setenv("YYT_CONFIG", filepath.Join(t.TempDir(), "c.json"))
	t.Setenv("YYT_TOKEN", "yyt_x")
	t.Setenv("YYT_API", "http://example.com")
	root := NewRoot(&App{Out: io.Discard, Err: io.Discard})
	root.SetArgs([]string{"whoami"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("err=%v", err)
	}
}

func TestMembers(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /members": func(recorded) (int, any) {
			return 200, map[string]any{"members": []map[string]any{
				{"id": "m_1", "login": "octo", "role": "admin", "createdAt": 1756000000, "approvedAt": 1756000100, "approvedBy": "m_0"},
				{"id": "m_2", "login": "newbie", "role": "pending", "createdAt": 1756001000, "approvedAt": nil, "approvedBy": nil},
			}}
		},
		"POST /members/m_2/approve": func(recorded) (int, any) {
			return 200, map[string]any{"id": "m_2", "login": "newbie", "role": "member"}
		},
	})
	out, _, err := run(t, f, "members", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "members_list", out)
	out, _, err = run(t, f, "members", "approve", "m_2")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "members_approve", out)
	_, _, err = run(t, f, "members", "demote", "m_9")
	if err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("err=%v", err)
	}
}

func TestTokens(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /tokens": func(recorded) (int, any) {
			return 200, map[string]any{"tokens": []map[string]any{{"id": "tok_1", "name": "ci", "createdAt": 1756000000, "lastUsedAt": nil}}}
		},
		"POST /tokens": func(r recorded) (int, any) {
			if r.Body["name"] != "laptop" {
				return 400, nil
			}
			return 201, map[string]any{"id": "tok_2", "name": "laptop", "createdAt": 1756000000, "token": "yyt_plain"}
		},
		"DELETE /tokens/tok_1": func(recorded) (int, any) { return 204, nil },
	})
	out, _, err := run(t, f, "tokens", "list")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "tokens_list", out)
	out, errs, err := run(t, f, "tokens", "create", "--name", "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "yyt_plain") || !strings.Contains(errs, "not shown again") {
		t.Fatalf("out=%q err=%q", out, errs)
	}
	out, _, err = run(t, f, "tokens", "revoke", "tok_1", "--json")
	if err != nil || !strings.Contains(out, `"revoked": true`) {
		t.Fatalf("%v %s", err, out)
	}
	if _, _, err = run(t, f, "tokens", "create"); err == nil {
		t.Fatal("--name required")
	}
}

func TestChannelsListAndGet(t *testing.T) {
	var projectListed int
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels": func(r recorded) (int, any) {
			if r.Path != "/channels?kind=auth&scope=all" {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": r.Path}}
			}
			return 200, map[string]any{"channels": []any{sampleChannel}}
		},
		"GET /channels/auth_0123": func(recorded) (int, any) { return 200, sampleChannel },
	}, []any{sampleChannel}, nil, nil))
	out, _, err := run(t, f, "channels", "list", "--kind", "auth", "--scope", "all")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "channels_list", out)
	out, errs, err := run(t, f, "channels", "get", "auth_0123")
	if err != nil {
		t.Fatal(err)
	}
	if errs != "" {
		t.Fatalf("get must not mention secrets: %q", errs)
	}
	golden(t, "channels_get", out)

	// A named context narrows the list to that project; a name resolves to the
	// id through the project's channel list (case-insensitively).
	f.reqs = nil
	if _, _, err := run(t, f, "channels", "list", "--team", "dooroo", "--project", "game"); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.reqs {
		if r.Path == "/channels" {
			t.Fatal("named context must use the project route")
		}
		projectListed++
	}
	if projectListed == 0 {
		t.Fatal("no request made")
	}
	out2, _, err := run(t, f, "channels", "get", "DEMO", "--project", "prj_1")
	if err != nil || out2 != out {
		t.Fatalf("name lookup: %v\n%s", err, out2)
	}
	// Reads auto-select the only team/project; an unknown name is a 404.
	if _, _, err := run(t, f, "channels", "get", "nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err=%v", err)
	}
}

func TestChannelsCreateFlags(t *testing.T) {
	var created map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/channels": func(r recorded) (int, any) {
			created = r.Body
			kind, _ := r.Body["kind"].(string)
			resp := map[string]any{}
			for k, v := range sampleChannel {
				resp[k] = v
			}
			resp["kind"] = kind
			if kind == "auth" {
				resp["secret"] = "s3cret"
			} else {
				resp["apiKey"] = "k3y"
			}
			return 201, resp
		},
	}, []any{sampleChannel}, nil, nil))
	t.Setenv("GITHUB_CLIENT_SECRET", "ghs")
	// A write command never auto-selects the project, even when it is the only one.
	if _, _, err := run(t, f, "channels", "create", "--kind", "auth", "--name", "demo", "--audience", "demo"); err == nil ||
		!strings.Contains(err.Error(), "no team context") {
		t.Fatalf("err=%v", err)
	}
	for _, r := range f.reqs {
		if r.Method == "POST" {
			t.Fatal("must not create without an explicit context")
		}
	}
	withProject(t)
	out, errs, err := run(t, f, "channels", "create", "--kind", "auth", "--name", "demo",
		"--audience", "demo", "--redirect", "https://a/", "--redirect", "https://b/", "--github-client-id", "gid", "--token-ttl", "3600")
	if err != nil {
		t.Fatal(err)
	}
	cfg := created["config"].(map[string]any)
	if cfg["audience"] != "demo" || cfg["tokenTtlSec"] != float64(3600) || len(cfg["redirectAllowlist"].([]any)) != 2 {
		t.Fatalf("config %v", cfg)
	}
	gh := cfg["providers"].(map[string]any)["github"].(map[string]any)
	if gh["clientId"] != "gid" || gh["clientSecret"] != "ghs" {
		t.Fatalf("github %v", gh)
	}
	if !strings.Contains(out, "secret:") || !strings.Contains(out, "s3cret") || !strings.Contains(errs, "not shown again") {
		t.Fatalf("out=%q errs=%q", out, errs)
	}

	// --auth-channel may be the auth channel's name; it resolves in the same project.
	out, _, err = run(t, f, "channels", "create", "--kind", "match", "--name", "m", "--auth-channel", "demo",
		"--party-size", "4", "--callback-url", "https://cb/", "--on-timeout", "partial", "--json")
	if err != nil {
		t.Fatal(err)
	}
	cfg = created["config"].(map[string]any)
	if cfg["authChannelId"] != "auth_0123" || cfg["partySize"] != float64(4) || cfg["onTimeout"] != "partial" || cfg["waitTimeoutSec"] != nil {
		t.Fatalf("config %v", cfg)
	}
	var j map[string]any
	if json.Unmarshal([]byte(out), &j) != nil || j["apiKey"] != "k3y" {
		t.Fatalf("json out %s", out)
	}

	// Missing required convenience flags fail before any request.
	n := len(f.reqs)
	for _, args := range [][]string{
		{"channels", "create", "--kind", "match", "--name", "m", "--auth-channel", "a"},
		{"channels", "create", "--kind", "auth", "--name", "a"},
		{"channels", "create", "--kind", "auth", "--name", "a", "--audience", "x", "--google-client-id", "g"},
		{"channels", "create", "--kind", "topic", "--name", "t"},
		{"channels", "create", "--kind", "bogus", "--name", "t"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Errorf("expected error for %v", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatal("validation must not hit the API")
	}

	// --config @file wins.
	p := filepath.Join(t.TempDir(), "c.json")
	_ = os.WriteFile(p, []byte(`{"authChannelId":"auth_x"}`), 0o600)
	if _, _, err := run(t, f, "channels", "create", "--kind", "topic", "--name", "t", "--config", "@"+p); err != nil {
		t.Fatal(err)
	}
	if created["config"].(map[string]any)["authChannelId"] != "auth_x" {
		t.Fatalf("%v", created)
	}
}

func TestChannelsUpdateExtendRotateDelete(t *testing.T) {
	var patched map[string]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /channels/auth_0123":   func(recorded) (int, any) { return 200, sampleChannel },
		"PATCH /channels/auth_0123": func(r recorded) (int, any) { patched = r.Body; return 200, sampleChannel },
		"POST /channels/auth_0123/extend": func(recorded) (int, any) {
			return 200, sampleChannel
		},
		"POST /channels/auth_0123/rotate-secret": func(recorded) (int, any) {
			m := map[string]any{}
			for k, v := range sampleChannel {
				m[k] = v
			}
			m["secret"] = "n3w"
			return 200, m
		},
		"DELETE /channels/auth_0123": func(recorded) (int, any) { return 204, nil },
	})
	// PATCH with only a provider id keeps the stored secret (no clientSecret key).
	t.Setenv("GITHUB_CLIENT_SECRET", "")
	if _, _, err := run(t, f, "channels", "update", "auth_0123", "--name", "renamed", "--github-client-id", "gid2"); err != nil {
		t.Fatal(err)
	}
	if patched["name"] != "renamed" {
		t.Fatalf("%v", patched)
	}
	gh := patched["config"].(map[string]any)["providers"].(map[string]any)["github"].(map[string]any)
	if gh["clientId"] != "gid2" || gh["clientSecret"] != nil {
		t.Fatalf("%v", gh)
	}
	// topic/match PATCH must carry the full config: flags are overlaid on the current one.
	matchCh := map[string]any{}
	for k, v := range sampleChannel {
		matchCh[k] = v
	}
	matchCh["id"], matchCh["kind"] = "match_1", "match"
	matchCh["config"] = map[string]any{"authChannelId": "auth_0123", "partySize": 2, "waitTimeoutSec": 60, "onTimeout": "fail", "callbackUrl": "https://cb/"}
	f2 := newFake(t, map[string]func(recorded) (int, any){
		"GET /channels/match_1":   func(recorded) (int, any) { return 200, matchCh },
		"PATCH /channels/match_1": func(r recorded) (int, any) { patched = r.Body; return 200, matchCh },
	})
	if _, _, err := run(t, f2, "channels", "update", "match_1", "--wait-timeout", "30"); err != nil {
		t.Fatal(err)
	}
	mc := patched["config"].(map[string]any)
	if mc["waitTimeoutSec"] != float64(30) || mc["partySize"] != float64(2) || mc["callbackUrl"] != "https://cb/" || patched["name"] != nil {
		t.Fatalf("%v", patched)
	}
	if _, _, err := run(t, f, "channels", "update", "auth_0123", "--github-client-secret", "s"); err == nil || !strings.Contains(err.Error(), "--github-client-id") {
		t.Fatalf("secret without id must fail: %v", err)
	}
	if _, _, err := run(t, f, "channels", "update", "auth_0123"); err == nil {
		t.Fatal("nothing to update must fail")
	}
	if _, _, err := run(t, f, "channels", "extend", "auth_0123"); err != nil {
		t.Fatal(err)
	}
	out, _, err := run(t, f, "channels", "rotate-secret", "auth_0123")
	if err != nil || !strings.Contains(out, "n3w") {
		t.Fatalf("%v %s", err, out)
	}
	out, _, err = run(t, f, "channels", "delete", "auth_0123")
	if err != nil || out != "deleted auth_0123\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestExitCodes(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /me": func(recorded) (int, any) {
			return 403, map[string]any{"error": map[string]any{"code": "forbidden", "message": "pending"}}
		},
	})
	t.Setenv("YYT_CONFIG", filepath.Join(t.TempDir(), "c.json"))
	t.Setenv("YYT_API", f.srv.URL)
	t.Setenv("YYT_TOKEN", "yyt_test")
	old := os.Args
	os.Args = []string{"yyt", "whoami"}
	defer func() { os.Args = old }()
	r, w, _ := os.Pipe()
	oldErr := os.Stderr
	os.Stderr = w
	code := Execute()
	os.Stderr = oldErr
	_ = w.Close()
	b, _ := io.ReadAll(r)
	if code != 4 || !strings.Contains(string(b), "forbidden: pending") {
		t.Fatalf("code=%d err=%s", code, b)
	}
}

func TestChannelsGatewayKinds(t *testing.T) {
	var sent map[string]any
	lobbyCfg := func() map[string]any {
		return map[string]any{
			"authChannelId": "auth_0123",
			"capabilities": map[string]any{
				"pos": true, "say": []any{"zone"}, "party": true, "event": true, "debug": false,
			},
			"flushIntervalMs": 200, "maxMoveDelta": 4, "rateLimit": 30,
			"partySizeMax": 4, "defaultZone": "lobby", "mapUrl": "",
		}
	}
	lobbyCh := map[string]any{
		"id": "lobby_1", "kind": "lobby", "name": "l", "projectId": "prj_1",
		"status": "active", "createdAt": 1, "expiresAt": 2,
		"config": lobbyCfg(), "wsUrl": "wss://gw-dev.yyt.life/?channel=lobby_1",
	}
	qCh := map[string]any{
		"id": "q_1", "kind": "q", "name": "q", "projectId": "prj_1",
		"status": "active", "createdAt": 1, "expiresAt": 2,
		"config": map[string]any{"authChannelId": "auth_0123"},
		"wsUrl":  "wss://gw-dev.yyt.life/?channel=q_1",
		"redis": map[string]any{
			"eventKeyPrefix": "game:dev:q_1:event:", "queueKeyPrefix": "game:dev:q_1:queue:",
			"lockKeyPrefix": "game:dev:q_1:lock:", "awaiterKeyPrefix": "game:dev:q_1:awaiter:",
			"channelPrefix": "game:out:dev:q_1:", "aclKeyPattern": "~game:dev:q_1:*",
			"aclChannelPattern": "&game:out:dev:q_1:*",
		},
	}
	withProject(t)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/channels": func(r recorded) (int, any) {
			sent = r.Body
			if r.Body["kind"] == "q" {
				return 201, qCh
			}
			return 201, lobbyCh
		},
		"GET /channels/lobby_1":   func(recorded) (int, any) { return 200, lobbyCh },
		"PATCH /channels/lobby_1": func(r recorded) (int, any) { sent = r.Body; return 200, lobbyCh },
		"GET /channels/q_1":       func(recorded) (int, any) { return 200, qCh },
	}, nil, nil, nil))

	// lobby create: capability flags land in the nested object, tuning at the top.
	out, errs, err := run(t, f, "channels", "create", "--kind", "lobby", "--name", "l",
		"--auth-channel", "auth_0123", "--cap-say", "zone", "--cap-say", "user",
		"--cap-debug", "--zone", "town", "--map-url", "https://d.yyt.life/m/1", "--party-size-max", "6")
	if err != nil {
		t.Fatal(err)
	}
	cfg := sent["config"].(map[string]any)
	caps := cfg["capabilities"].(map[string]any)
	if len(caps["say"].([]any)) != 2 || caps["debug"] != true || caps["pos"] != nil {
		t.Fatalf("capabilities %v", caps)
	}
	if cfg["defaultZone"] != "town" || cfg["mapUrl"] != "https://d.yyt.life/m/1" || cfg["partySizeMax"] != float64(6) {
		t.Fatalf("config %v", cfg)
	}
	// Nothing to print once, and nothing is printed once.
	if strings.Contains(errs, "not shown again") || strings.Contains(out, "apiKey") {
		t.Fatalf("lobby has no secret: out=%q errs=%q", out, errs)
	}

	// q create: only the auth link travels; the prefixes come back derived.
	out, _, err = run(t, f, "channels", "create", "--kind", "q", "--name", "q", "--auth-channel", "auth_0123")
	if err != nil {
		t.Fatal(err)
	}
	if len(sent["config"].(map[string]any)) != 1 {
		t.Fatalf("q config %v", sent["config"])
	}
	// All four key prefixes plus the channel prefix and both ACL patterns:
	// handleActor needs four, and one the participant invents falls outside
	// the ACL the issued Redis account carries.
	for _, want := range []string{
		"redis.eventKeyPrefix:    game:dev:q_1:event:",
		"redis.queueKeyPrefix:    game:dev:q_1:queue:",
		"redis.lockKeyPrefix:     game:dev:q_1:lock:",
		"redis.awaiterKeyPrefix:  game:dev:q_1:awaiter:",
		"redis.channelPrefix:     game:out:dev:q_1:",
		"redis.aclKeyPattern:     ~game:dev:q_1:*",
		"redis.aclChannelPattern: &game:out:dev:q_1:*",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("q view must show %q: %s", want, out)
		}
	}

	// lobby update: a capability flag merges into the stored object rather than
	// replacing it, and the untouched top-level fields survive the full replace.
	if _, _, err := run(t, f, "channels", "update", "lobby_1", "--cap-party=false"); err != nil {
		t.Fatal(err)
	}
	cfg = sent["config"].(map[string]any)
	caps = cfg["capabilities"].(map[string]any)
	if caps["party"] != false || caps["pos"] != true || caps["event"] != true {
		t.Fatalf("merged capabilities %v", caps)
	}
	if cfg["flushIntervalMs"] != float64(200) || cfg["partySizeMax"] != float64(4) {
		t.Fatalf("merged config %v", cfg)
	}

	// `none` is the only way to say "no chat", and it is what makes
	// --cap-pos=false usable at all.
	if _, _, err := run(t, f, "channels", "create", "--kind", "lobby", "--name", "l",
		"--auth-channel", "auth_0123", "--cap-pos=false", "--cap-say", "none"); err != nil {
		t.Fatal(err)
	}
	if say := sent["config"].(map[string]any)["capabilities"].(map[string]any)["say"]; len(say.([]any)) != 0 {
		t.Fatalf("--cap-say none must send an empty list, got %v", say)
	}

	// Validation happens before any request.
	n := len(f.reqs)
	for _, args := range [][]string{
		{"channels", "create", "--kind", "lobby", "--name", "l"},
		{"channels", "create", "--kind", "q", "--name", "q"},
		{"channels", "list", "--kind", "lobbies"},
		{"channels", "create", "--kind", "lobby", "--name", "l", "--auth-channel", "a", "--cap-say", "none", "--cap-say", "user"},
		// A flag that belongs to another kind must fail, not silently no-op.
		{"channels", "create", "--kind", "q", "--name", "q", "--auth-channel", "a", "--cap-debug"},
		{"channels", "create", "--kind", "lobby", "--name", "l", "--auth-channel", "a", "--callback-url", "https://x/"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Errorf("expected error for %v", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatal("validation must not hit the API")
	}
	if _, _, err := run(t, f, "channels", "update", "q_1", "--cap-debug"); err == nil ||
		!strings.Contains(err.Error(), "does not apply to a q channel") {
		t.Fatalf("update must refuse a foreign flag: %v", err)
	}
}

func TestSelfVersionAndUpdateCheck(t *testing.T) {
	f := newFake(t, nil)
	out, _, err := run(t, f, "self", "version")
	if err != nil || !strings.HasPrefix(out, "yyt dev (") {
		t.Fatalf("out=%q err=%v", out, err)
	}
	// A `dev` build sorts below every release; pin a real version so the pin
	// path below can be a downgrade.
	prev := api.Version
	api.Version = "0.3.5"
	t.Cleanup(func() { api.Version = prev })
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/releases" {
			_, _ = w.Write([]byte(`[{"tag_name":"cli/v0.3.0"},{"tag_name":"cli/v0.4.0"}]`))
			return
		}
		t.Errorf("unexpected download %s", r.URL.Path)
		w.WriteHeader(404)
	}))
	t.Cleanup(gh.Close)
	up := &selfupdate.Updater{ReleasesAPI: gh.URL + "/releases", DownloadBase: gh.URL + "/download/", HTTP: gh.Client(), OS: "linux", Arch: "amd64"}
	var o bytes.Buffer
	a := &App{Out: &o, Err: &o, Updater: up}
	root := NewRoot(a)
	root.SetArgs([]string{"self", "update", "--check", "--json"})
	if err := root.Execute(); !errors.Is(err, ErrUpdateAvailable) {
		t.Fatalf("want ErrUpdateAvailable, got %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(o.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["latest"] != "0.4.0" || got["updateAvailable"] != true || got["current"] != "0.3.5" {
		t.Fatalf("got %v", got)
	}
	// `--check` signals an available update through the error → exit 7.
	root = NewRoot(a)
	root.SetArgs([]string{"self", "update", "--check"})
	if err := root.Execute(); !errors.Is(err, ErrUpdateAvailable) {
		t.Fatalf("want ErrUpdateAvailable, got %v", err)
	}
	// An older pin under --check is not "available", and --json stays JSON.
	o.Reset()
	root = NewRoot(a)
	root.SetArgs([]string{"self", "update", "--check", "--version", "0.0.0", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(o.Bytes(), &got); err != nil || got["updateAvailable"] != false {
		t.Fatalf("pin check: %s %v", o.String(), err)
	}
	root = NewRoot(a)
	root.SetArgs([]string{"self", "update", "--version", "1.0.0?x=1"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "invalid version") {
		t.Fatalf("bad pin accepted: %v", err)
	}
	if len(f.reqs) != 0 {
		t.Fatal("self commands must not call the console API")
	}
}

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const pushID = "push_0123456789abcdef"

// fakeKey stands in for a service-account key file: the marker must never
// reach stdout or stderr.
const fakeKey = `{"type":"service_account","project_id":"team-proj","private_key":"KEY-MARKER"}`

func samplePush(over map[string]any) map[string]any {
	m := map[string]any{
		"id": pushID, "kind": "push", "name": "alerts",
		"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
		"config":    map[string]any{"authChannelId": "auth_0123", "packageName": "com.example.game", "sender": "platform"},
		"createdAt": 1756000000, "expiresAt": 1756604800, "disabledAt": nil, "status": "active",
		"registered": true, "apiBase": "https://state.example",
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

func apiErr(code, message string, details map[string]any) map[string]any {
	e := map[string]any{"code": code, "message": message}
	if details != nil {
		e["details"] = details
	}
	return map[string]any{"error": e}
}

func TestPushChannelListGet(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
	}, []any{samplePush(nil)}, nil, nil))

	// The kind is fixed: there is no --kind, and the list asks for push only.
	out, _, err := run(t, f, "push", "channel", "ls", "--project", "prj_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_channel_list", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/projects/prj_1/channels?kind=push" {
		t.Errorf("list path = %s", got)
	}
	if _, _, err := run(t, f, "push", "channel", "ls", "--kind", "auth"); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("--kind under push: %v", err)
	}

	// By id: no context is needed, and nothing mentions a secret.
	f.reqs = nil
	out, errs, err := run(t, f, "push", "channel", "get", pushID)
	if err != nil {
		t.Fatal(err)
	}
	if errs != "" {
		t.Errorf("stderr = %q", errs)
	}
	golden(t, "push_channel_get", out)
	for _, r := range f.reqs {
		if r.Path != "/channels/"+pushID {
			t.Errorf("an id must not walk the context: %s", r.Path)
		}
	}
	// By name: looked up among the project's push channels only.
	f.reqs = nil
	byName, _, err := run(t, f, "push", "channel", "get", "ALERTS", "--project", "prj_1")
	if err != nil || byName != out {
		t.Fatalf("by name: %v\n%s", err, byName)
	}
	var listed bool
	for _, r := range f.reqs {
		listed = listed || r.Path == "/projects/prj_1/channels?kind=push"
	}
	if !listed {
		t.Errorf("name lookup did not filter by kind: %v", f.reqs)
	}
	// The generic family reads the same channel, by the same id.
	generic, _, err := run(t, f, "channels", "get", pushID)
	if err != nil || generic != out {
		t.Fatalf("channels get: %v\n%s", err, generic)
	}

	// Another kind's id is refused before any request.
	f.reqs = nil
	for _, verb := range []string{"get", "delete", "rotate", "config"} {
		if _, _, err := run(t, f, "push", "channel", verb, "auth_0123"); err == nil || !strings.Contains(err.Error(), "not a push channel") {
			t.Errorf("%s auth_0123: %v", verb, err)
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests for a foreign id: %v", f.reqs)
	}
}

// `push` is in idLike: a `push_…` argument is an id, sent as it is with no
// lookup, and never read as a name.
func TestPushIDIsNeverAName(t *testing.T) {
	named := samplePush(map[string]any{"id": "push_aaaa", "name": "beta"})
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/push_aaaa": func(recorded) (int, any) { return 200, named },
		"GET /channels/push_gone": func(recorded) (int, any) { return 404, apiErr("not_found", "channel not found", nil) },
	}, []any{named}, nil, nil))
	withProject(t)
	if !IsID("push_aaaa") || !IsID("PUSH_x") {
		t.Fatal("push_ must be id-like")
	}
	out, _, err := run(t, f, "push", "channel", "get", "push_aaaa", "--json")
	if err != nil || !strings.Contains(out, `"id": "push_aaaa"`) {
		t.Fatalf("by id: %v\n%s", err, out)
	}
	if len(f.reqs) != 1 {
		t.Errorf("an id needs one request and no list: %v", f.reqs)
	}
	f.reqs = nil
	if _, _, err := run(t, f, "push", "channel", "get", "push_gone"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("unknown id: %v", err)
	}
	if len(f.reqs) != 1 {
		t.Errorf("a 404 on an id is the answer, not a name lookup: %v", f.reqs)
	}
	// A name still resolves among the push channels of the project.
	out, _, err = run(t, f, "push", "channel", "get", "beta", "--json")
	if err != nil || !strings.Contains(out, `"id": "push_aaaa"`) {
		t.Fatalf("by name: %v\n%s", err, out)
	}
}

func TestPushChannelCreate(t *testing.T) {
	var body map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/channels": func(r recorded) (int, any) {
			body = r.Body
			return 201, samplePush(map[string]any{"apiKey": "pk_once"})
		},
	}, []any{sampleChannel}, nil, nil))
	withProject(t)

	// --auth takes the auth channel's name; the sender defaults server-side.
	out, errs, err := run(t, f, "push", "channel", "create", "--name", "alerts", "--auth", "demo", "--package", "com.example.game")
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := body["config"].(map[string]any)
	if body["kind"] != "push" || body["name"] != "alerts" || cfg["authChannelId"] != "auth_0123" || cfg["packageName"] != "com.example.game" || len(cfg) != 2 {
		t.Fatalf("body = %v", body)
	}
	if !strings.Contains(out, "apiKey:") || !strings.Contains(out, "pk_once") || !strings.Contains(errs, "store the secret now") {
		t.Errorf("apiKey not shown once:\n%s\n%s", out, errs)
	}
	// `yyt channels create --kind push` is the same request.
	first := body
	if _, _, err := run(t, f, "channels", "create", "--kind", "push", "--name", "alerts", "--auth-channel", "auth_0123", "--package", "com.example.game"); err != nil {
		t.Fatal(err)
	}
	if c2, _ := body["config"].(map[string]any); body["kind"] != first["kind"] || c2["authChannelId"] != cfg["authChannelId"] || c2["packageName"] != cfg["packageName"] || len(c2) != 2 {
		t.Errorf("generic body = %v", body)
	}

	// A team sender carries the key file, from a path or from stdin, and the
	// key is never echoed.
	keyFile := filepath.Join(t.TempDir(), "sa.json")
	if err := os.WriteFile(keyFile, []byte(fakeKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]*strings.Reader{keyFile: strings.NewReader(""), "-": strings.NewReader(fakeKey)} {
		body = nil
		out, errs, err := runIn(t, f, in, "push", "channel", "create", "--name", "alerts", "--auth", "auth_0123", "--package", "com.example.game", "--sender", "team", "--service-account", name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		cfg, _ := body["config"].(map[string]any)
		if cfg["sender"] != "team" || cfg["teamServiceAccount"] != fakeKey {
			t.Errorf("%s: config = %v", name, cfg)
		}
		if strings.Contains(out+errs, "KEY-MARKER") {
			t.Errorf("%s: the key was printed", name)
		}
	}

	// Refused locally, with no request and nothing of the file in the error.
	junk := filepath.Join(t.TempDir(), "junk.txt")
	if err := os.WriteFile(junk, []byte("JUNK-MARKER not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.reqs = nil
	base := []string{"push", "channel", "create", "--name", "alerts", "--auth", "auth_0123"}
	for want, extra := range map[string][]string{
		"--package is required":               {},
		"--sender must be platform|team":      {"--package", "com.example.game", "--sender", "fcm"},
		"--sender team needs":                 {"--package", "com.example.game", "--sender", "team"},
		"--service-account needs":             {"--package", "com.example.game", "--service-account", keyFile},
		"not a JSON object":                   {"--package", "com.example.game", "--sender", "team", "--service-account", junk},
		"--service-account: open":             {"--package", "com.example.game", "--sender", "team", "--service-account", filepath.Join(t.TempDir(), "absent.json")},
		"alias of --auth":                     {"--package", "com.example.game", "--auth-channel", "auth_0123"},
		"unknown flag: --party-size":          {"--package", "com.example.game", "--party-size", "2"},
		"--party-size does not apply to a pu": nil, // the generic family, below
	} {
		args := append(append([]string{}, base...), extra...)
		if extra == nil {
			args = []string{"channels", "create", "--kind", "push", "--name", "alerts", "--auth-channel", "auth_0123", "--package", "com.example.game", "--party-size", "2"}
		}
		_, _, err := run(t, f, args...)
		if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), "JUNK-MARKER") {
			t.Errorf("want %q, got %v", want, err)
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests for refused flags: %v", f.reqs)
	}
}

func TestPushCreateHints(t *testing.T) {
	var status int
	var details map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/channels": func(recorded) (int, any) {
			return status, apiErr("refused", "no", details)
		},
	}, nil, nil, nil))
	withProject(t)
	create := []string{"push", "channel", "create", "--name", "alerts", "--auth", "auth_0123", "--package", "com.example.game"}
	for _, c := range []struct {
		status  int
		details map[string]any
		want    string
		args    []string
	}{
		// The limit names the request to make, in the team the project is in.
		{409, map[string]any{"limit": "push.appsPerTeam", "value": 2}, `yyt limit request push.appsPerTeam +1 --team team_1 --reason "..."`, nil},
		{409, map[string]any{"limit": "push.appsPerTeam", "value": 2}, `yyt limit request push.appsPerTeam +1 --team dooroo --reason "..."`, []string{"--team", "dooroo", "--project", "game"}},
		{409, map[string]any{"reason": "package_taken"}, "another push channel on this stage holds that package", nil},
		{400, map[string]any{"reason": "package_refused"}, "Firebase refused the package name", nil},
		{400, map[string]any{"reason": "service_account", "field": "private_key"}, "private_key is missing or not a usable RSA key; pass the service-account key file Firebase downloaded, unedited", nil},
		// A field this CLI does not know still gets the general hint.
		{400, map[string]any{"reason": "service_account", "field": "later"}, "(pass the service-account key file Firebase downloaded, unedited)", nil},
		{409, map[string]any{"reason": "package_taken"}, "--sender team", nil},
		// The per-member write slot.
		{429, map[string]any{"retryAfterMs": 500}, "two writes a second", nil},
		{503, map[string]any{"reason": "push_not_configured"}, "no push sender yet", nil},
		{503, map[string]any{"reason": "push_pool_full"}, "yyt push pool", nil},
		{503, map[string]any{"reason": "firebase_unavailable"}, "try again shortly", nil},
	} {
		status, details = c.status, c.details
		_, _, err := run(t, f, append(append([]string{}, create...), c.args...)...)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: want %q, got %v", c.details, c.want, err)
		}
	}
	// The generic family gives the same hints for the push kind.
	status, details = 409, map[string]any{"reason": "package_taken"}
	if _, _, err := run(t, f, "channels", "create", "--kind", "push", "--name", "alerts", "--auth-channel", "auth_0123", "--package", "com.example.game"); err == nil || !strings.Contains(err.Error(), "holds that package") {
		t.Errorf("generic hint: %v", err)
	}
	// An unexplained refusal passes through untouched.
	status, details = 409, nil
	if _, _, err := run(t, f, create...); err == nil || strings.Contains(err.Error(), "(") {
		t.Errorf("plain refusal: %v", err)
	}
}

// push.appsPerTeam is a team limit outside the `team.` namespace: it must
// pick the team scope by itself, or the hint above names a request that fails.
func TestPushAppsLimitIsTeamScoped(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /limits": func(recorded) (int, any) {
			return 200, map[string]any{"limits": []any{
				map[string]any{"key": "push.appsPerTeam", "unit": "count", "soft": 2, "hard": 5, "effective": 2, "usage": 2, "step": 1, "next": 3, "override": nil},
			}, "pending": []any{}}
		},
		"POST /limit-requests": func(recorded) (int, any) { return 201, sampleRequest },
	}, nil, nil, nil))
	if _, _, err := run(t, f, "limit", "request", "push.appsPerTeam", "+1", "--team", "team_1", "--reason", "a second game"); err != nil {
		t.Fatal(err)
	}
	body := f.reqs[len(f.reqs)-1].Body
	if body["scope"] != "team:team_1" || body["key"] != "push.appsPerTeam" || body["value"] != float64(3) {
		t.Errorf("request body = %v", body)
	}
	if _, _, err := run(t, f, "limit", "request", "push.appsPerTeam", "+1", "--team", "team_1", "--scope", "project", "--reason", "r"); err == nil || !strings.Contains(err.Error(), "is a team limit") {
		t.Errorf("--scope project: %v", err)
	}
}

func TestPushChannelUpdateRotateDelete(t *testing.T) {
	var patched map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID:   func(recorded) (int, any) { return 200, samplePush(nil) },
		"PATCH /channels/" + pushID: func(r recorded) (int, any) { patched = r.Body; return 200, samplePush(nil) },
		"POST /channels/" + pushID + "/rotate-secret": func(recorded) (int, any) {
			return 200, samplePush(map[string]any{"apiKey": "pk_new"})
		},
		"DELETE /channels/" + pushID: func(recorded) (int, any) { return 204, nil },
	}, []any{
		sampleChannel,
		map[string]any{"id": "auth_9999", "kind": "auth", "name": "other"},
	}, nil, nil))
	withProject(t)

	// The PATCH replaces the config, so the stored package and sender go back
	// with the new auth channel (the server accepts them only when unchanged).
	if _, _, err := run(t, f, "push", "channel", "update", pushID, "--name", "renamed", "--auth", "other"); err != nil {
		t.Fatal(err)
	}
	cfg, _ := patched["config"].(map[string]any)
	if patched["name"] != "renamed" || cfg["authChannelId"] != "auth_9999" || cfg["packageName"] != "com.example.game" || cfg["sender"] != "platform" || len(cfg) != 3 {
		t.Fatalf("patch = %v", patched)
	}
	// A rename alone sends no config.
	if _, _, err := run(t, f, "push", "channel", "update", pushID, "--name", "again"); err != nil {
		t.Fatal(err)
	}
	if _, has := patched["config"]; has || patched["name"] != "again" {
		t.Errorf("patch = %v", patched)
	}
	// Fixed at creation: not a flag here, and a clear refusal in the generic family.
	patched = nil
	if _, _, err := run(t, f, "push", "channel", "update", pushID, "--package", "com.example.other"); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("--package: %v", err)
	}
	if _, _, err := run(t, f, "channels", "update", pushID, "--sender", "team"); err == nil || !strings.Contains(err.Error(), "fixed at creation") {
		t.Errorf("--sender: %v", err)
	}
	if _, _, err := run(t, f, "channels", "update", pushID, "--service-account", "x.json"); err == nil || !strings.Contains(err.Error(), "sender-key set") {
		t.Errorf("--service-account: %v", err)
	}
	if _, _, err := run(t, f, "push", "channel", "update", pushID); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Errorf("empty update: %v", err)
	}
	if patched != nil {
		t.Errorf("a refused update was sent: %v", patched)
	}

	// `rotate` and `rotate-secret` are one command in both families.
	for _, args := range [][]string{
		{"push", "channel", "rotate", pushID},
		{"push", "channel", "rotate-secret", pushID},
		{"channels", "rotate", pushID},
	} {
		out, errs, err := run(t, f, args...)
		if err != nil || !strings.Contains(out, "pk_new") || !strings.Contains(errs, "store the secret now") {
			t.Errorf("%v: %v\n%s", args, err, out)
		}
	}
	out, _, err := run(t, f, "push", "channel", "delete", pushID)
	if err != nil || out != "deleted "+pushID+"\n" {
		t.Errorf("delete: %v %q", err, out)
	}
	// The credentials of other kinds are not part of this family.
	if _, _, err := run(t, f, "push", "channel", "doc-key", "show", pushID); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Errorf("doc-key: %v", err)
	}
}

func TestPushChannelConfig(t *testing.T) {
	registered := true
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
		"GET /channels/" + pushID + "/google-services.json": func(recorded) (int, any) {
			if !registered {
				return 409, apiErr("conflict", "a team-sender channel has no platform registration", map[string]any{"reason": "not_registered"})
			}
			return 200, map[string]any{"project_info": map[string]any{"project_id": "example-project"}, "client": []any{}}
		},
	}, nil, nil, nil))
	t.Chdir(t.TempDir())
	const want = `{"client":[],"project_info":{"project_id":"example-project"}}` + "\n"

	// Default name in the current directory; stdout stays empty.
	out, errs, err := run(t, f, "push", "channel", "config", pushID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile("google-services.json")
	if string(got) != want || out != "" || !strings.Contains(errs, "wrote google-services.json (") {
		t.Errorf("file = %q, out = %q, err = %q", got, out, errs)
	}
	// An existing file is kept, before any request, unless --force.
	if err := os.WriteFile("google-services.json", []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.reqs = nil
	if _, _, err := run(t, f, "push", "channel", "config", pushID); err == nil || !strings.Contains(err.Error(), "exists: pass --force") {
		t.Errorf("overwrite: %v", err)
	}
	if got, _ := os.ReadFile("google-services.json"); string(got) != "mine" || len(f.reqs) != 0 {
		t.Errorf("file = %q, reqs = %v", got, f.reqs)
	}
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "--force"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile("google-services.json"); string(got) != want {
		t.Errorf("forced file = %q", got)
	}
	// -o names another file; -o - is stdout and writes nothing.
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "-o", "app.json"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile("app.json"); string(got) != want {
		t.Errorf("-o file = %q", got)
	}
	out, errs, err = run(t, f, "push", "channel", "config", pushID, "-o", "-")
	if err != nil || out != want || errs != "" {
		t.Errorf("stdout: %v %q %q", err, out, errs)
	}
	// A refusal leaves no file behind and says where the file comes from.
	registered = false
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "-o", "none.json"); err == nil || !strings.Contains(err.Error(), "from its own Firebase project") {
		t.Errorf("not_registered: %v", err)
	}
	if entries, _ := os.ReadDir("."); len(entries) != 2 {
		t.Errorf("leftovers: %v", entries)
	}
}

// Every google-services.json download takes the member's write slot, and a
// PATCH with config is refused while the registration is under way: both
// say what to do, and the second does not borrow the download's wording.
func TestPushRateLimitAndUnfinishedRegistration(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
		"GET /channels/" + pushID + "/google-services.json": func(recorded) (int, any) {
			return 429, apiErr("rate_limited", "too many writes; slow down", map[string]any{"retryAfterMs": 500})
		},
		"PATCH /channels/" + pushID: func(recorded) (int, any) {
			return 409, apiErr("conflict", "the channel's registration is not finished", map[string]any{"reason": "not_registered"})
		},
	}, []any{sampleChannel}, nil, nil))
	withProject(t)
	t.Chdir(t.TempDir())
	if _, _, err := run(t, f, "push", "channel", "config", pushID); err == nil || !strings.Contains(err.Error(), "a config download counts as one") {
		t.Errorf("429: %v", err)
	}
	if entries, _ := os.ReadDir("."); len(entries) != 0 {
		t.Errorf("a refused download left %v", entries)
	}
	for _, args := range [][]string{
		{"push", "channel", "update", pushID, "--auth", "auth_0123"},
		{"channels", "update", pushID, "--auth-channel", "auth_0123"},
	} {
		_, _, err := run(t, f, args...)
		if err == nil || !strings.Contains(err.Error(), "registration is not finished, so its config cannot change yet") {
			t.Errorf("%v: %v", args, err)
		}
		if err != nil && strings.Contains(err.Error(), "own Firebase project") {
			t.Errorf("%v borrowed the download's hint: %v", args, err)
		}
	}
}

func TestPushSenderKey(t *testing.T) {
	var put map[string]any
	removed, teamSender := true, false
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
		"PUT /channels/" + pushID + "/sender-key": func(r recorded) (int, any) {
			put = r.Body
			return 200, samplePush(map[string]any{"teamProject": "team-proj"})
		},
		"DELETE /channels/" + pushID + "/sender-key": func(recorded) (int, any) {
			if teamSender {
				return 409, apiErr("conflict", "a team-sender channel cannot drop its only sender; rotate the key or delete the channel", nil)
			}
			return 200, map[string]any{"removed": removed}
		},
	}, nil, nil, nil))
	keyFile := filepath.Join(t.TempDir(), "sa.json")
	if err := os.WriteFile(keyFile, []byte(fakeKey), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]*strings.Reader{keyFile: strings.NewReader(""), "-": strings.NewReader("\n" + fakeKey + "\n")} {
		put = nil
		out, errs, err := runIn(t, f, in, "push", "channel", "sender-key", "set", pushID, "--service-account", name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if put["serviceAccount"] != fakeKey || len(put) != 1 {
			t.Errorf("%s: body = %v", name, put)
		}
		// The answer is the channel, with the key's project and not the key.
		if !strings.Contains(out, "teamProject: team-proj") || strings.Contains(out+errs, "KEY-MARKER") {
			t.Errorf("%s: out = %s%s", name, out, errs)
		}
	}
	// Nothing is sent for a file that is not a key, or for no file at all.
	f.reqs = nil
	if _, _, err := runIn(t, f, strings.NewReader("[1,2]"), "push", "channel", "sender-key", "set", pushID, "--service-account", "-"); err == nil || !strings.Contains(err.Error(), "not a JSON object") {
		t.Errorf("array: %v", err)
	}
	if _, _, err := runIn(t, f, strings.NewReader(strings.Repeat(" ", serviceAccountMax+1)), "push", "channel", "sender-key", "set", pushID, "--service-account", "-"); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Errorf("oversize: %v", err)
	}
	if _, _, err := run(t, f, "push", "channel", "sender-key", "set", pushID); err == nil || !strings.Contains(err.Error(), "service-account") {
		t.Errorf("missing flag: %v", err)
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests for a bad key: %v", f.reqs)
	}

	out, _, err := run(t, f, "push", "channel", "sender-key", "rm", pushID)
	if err != nil || out != "removed the sender key of "+pushID+"\n" {
		t.Errorf("rm: %v %q", err, out)
	}
	removed = false
	out, _, err = run(t, f, "push", "channel", "sender-key", "rm", pushID)
	if err != nil || out != pushID+" had no sender key\n" {
		t.Errorf("rm again: %v %q", err, out)
	}
	out, _, err = run(t, f, "push", "channel", "sender-key", "rm", pushID, "--json")
	if err != nil || !strings.Contains(out, `"removed": false`) {
		t.Errorf("rm --json: %v %q", err, out)
	}
	// The server's own message already says what to do.
	teamSender = true
	if _, _, err := run(t, f, "push", "channel", "sender-key", "rm", pushID); err == nil || !strings.Contains(err.Error(), "rotate the key or delete the channel") {
		t.Errorf("team sender: %v", err)
	}
}

func TestPushPool(t *testing.T) {
	configured := true
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /admin/push/pool": func(recorded) (int, any) {
			if !configured {
				return 200, map[string]any{"configured": false, "slots": []any{}}
			}
			return 200, map[string]any{"configured": true, "slots": []any{
				map[string]any{"slot": "p1", "provisioned": true, "closed": true, "closedBy": "m_1", "closedByLogin": "octo", "closedAt": 1756000000, "apps": 20, "capacity": 20},
				map[string]any{"slot": "p2", "provisioned": true, "closed": false, "closedBy": nil, "closedByLogin": nil, "closedAt": nil, "apps": 3, "capacity": 20},
				map[string]any{"slot": "p3", "provisioned": true, "closed": true, "closedBy": "system", "closedByLogin": nil, "closedAt": 1756000100, "apps": 12, "capacity": 20},
				map[string]any{"slot": "p9", "provisioned": false, "closed": false, "closedBy": nil, "closedByLogin": nil, "closedAt": nil, "apps": 1, "capacity": 20},
			}}
		},
		"POST /admin/push/pool/p2/close": func(recorded) (int, any) {
			return 200, map[string]any{"slot": "p2", "closed": true, "changed": true}
		},
		"POST /admin/push/pool/p2/open": func(recorded) (int, any) {
			return 200, map[string]any{"slot": "p2", "closed": false, "changed": false}
		},
		"POST /admin/push/pool/p7/close": func(recorded) (int, any) {
			return 404, apiErr("not_found", "no such slot", nil)
		},
	})
	out, errs, err := run(t, f, "push", "pool")
	if err != nil || errs != "" {
		t.Fatal(err, errs)
	}
	golden(t, "push_pool", out)
	if ls, _, err := run(t, f, "push", "pool", "ls"); err != nil || ls != out {
		t.Errorf("ls: %v\n%s", err, ls)
	}
	out, _, err = run(t, f, "push", "pool", "close", "p2")
	if err != nil || out != "closed p2\n" {
		t.Errorf("close: %v %q", err, out)
	}
	out, _, err = run(t, f, "push", "pool", "open", "p2")
	if err != nil || out != "p2 was already open\n" {
		t.Errorf("open: %v %q", err, out)
	}
	out, _, err = run(t, f, "push", "pool", "open", "p2", "--json")
	if err != nil || !strings.Contains(out, `"changed": false`) {
		t.Errorf("open --json: %v %q", err, out)
	}
	if _, _, err := run(t, f, "push", "pool", "close", "p7"); err == nil || !strings.Contains(err.Error(), "no such slot") {
		t.Errorf("unknown slot: %v", err)
	}
	if _, _, err := run(t, f, "push", "pool", "drain"); err == nil {
		t.Error("an unknown pool verb must fail")
	}
	configured = false
	_, errs, err = run(t, f, "push", "pool")
	if err != nil || !strings.Contains(errs, "no push sender configured") {
		t.Errorf("unconfigured: %v %q", err, errs)
	}
}

// Sending is a data-plane call with the channel apiKey; the CLI has no such
// command and says where sending happens instead.
func TestPushHasNoSend(t *testing.T) {
	f := newFake(t, nil)
	if _, _, err := run(t, f, "push", "send", pushID); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Errorf("push send: %v", err)
	}
	out, _, err := run(t, f, "push", "--help")
	if err != nil || !strings.Contains(out, "POST /push/{channel}/send") || !strings.Contains(out, "This CLI does not send") {
		t.Errorf("help: %v\n%s", err, out)
	}
}

package cmd

import (
	"strings"
	"testing"
)

// A console-minted id (`trc_` + lowercase ULID, TRACER_ID_RE in console-db).
const trcMgmtID = "trc_01hf7yavygfgdxpjfmr5r0g6ca"

func sampleTracer(dsn any) map[string]any {
	return map[string]any{
		"id": trcMgmtID, "name": "app-debug", "teamId": "team_1", "teamName": "dooroo",
		"projectId": "prj_1", "projectName": "game", "createdBy": "alice",
		"writeKey": "0123456789abcdef0123456789abcdef", "dsn": dsn, "readUrl": nil,
		"noBackup": true, "createdAt": 1762600000, "updatedAt": 1762600000,
	}
}

const sampleDSN = "https://0123456789abcdef0123456789abcdef@trace-dev.yyt.life/" + trcMgmtID

func tracerConsole(t *testing.T, dsn any, extra map[string]func(recorded) (int, any)) *fakeConsole {
	routes := map[string]func(recorded) (int, any){
		"GET /projects/prj_1/tracers": func(recorded) (int, any) {
			return 200, map[string]any{"tracers": []any{sampleTracer(dsn)}}
		},
		"GET /tracers/" + trcMgmtID:    func(recorded) (int, any) { return 200, sampleTracer(dsn) },
		"POST /projects/prj_1/tracers": func(r recorded) (int, any) { return 201, sampleTracer(dsn) },
		"PATCH /tracers/" + trcMgmtID: func(r recorded) (int, any) {
			v := sampleTracer(dsn)
			v["name"] = r.Body["name"]
			return 200, v
		},
		"POST /tracers/" + trcMgmtID + "/rotate-key": func(recorded) (int, any) {
			v := sampleTracer(dsn)
			v["writeKey"] = "fedcba9876543210fedcba9876543210"
			return 200, v
		},
		"DELETE /tracers/" + trcMgmtID: func(recorded) (int, any) { return 204, nil },
	}
	for k, v := range extra {
		routes[k] = v
	}
	return newFake(t, ctxRoutes(routes, nil, nil, nil))
}

func TestTracerManagement(t *testing.T) {
	withProject(t)
	t.Setenv("YYT_TRACER_LOCAL", "")
	f := tracerConsole(t, sampleDSN, nil)

	out, _, err := run(t, f, "tracer", "ls")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, trcMgmtID) || !strings.Contains(out, sampleDSN) {
		t.Fatalf("list output:\n%s", out)
	}

	out, _, err = run(t, f, "tracer", "create", "app-debug", "--description", "android")
	if err != nil {
		t.Fatal(err)
	}
	if body := f.reqs[len(f.reqs)-1].Body; body["name"] != "app-debug" || body["description"] != "android" {
		t.Fatalf("create body %v", body)
	}
	for _, want := range []string{"writeKey", "0123456789abcdef0123456789abcdef", sampleDSN, "backup"} {
		if !strings.Contains(out, want) {
			t.Fatalf("create output lacks %q:\n%s", want, out)
		}
	}

	// A name resolves through the project's list; the detail is then by id.
	if _, _, err := run(t, f, "tracer", "get", "app-debug"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Path; got != "/tracers/"+trcMgmtID {
		t.Fatalf("get path %s", got)
	}

	if _, _, err := run(t, f, "tracer", "rename", trcMgmtID, "android-debug"); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Method != "PATCH" || last.Body["name"] != "android-debug" || len(last.Body) != 1 {
		t.Fatalf("rename request %+v", last)
	}

	out, _, err = run(t, f, "tracer", "rotate", "app-debug")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "fedcba9876543210fedcba9876543210") {
		t.Fatalf("rotate output:\n%s", out)
	}

	out, _, err = run(t, f, "tracer", "dsn", "app-debug")
	if err != nil {
		t.Fatal(err)
	}
	if out != sampleDSN+"\n" {
		t.Fatalf("dsn output %q", out)
	}

	out, _, err = run(t, f, "tracer", "rm", trcMgmtID)
	if err != nil || out != "deleted "+trcMgmtID+"\n" {
		t.Fatalf("delete: %q %v", out, err)
	}
}

func TestTracerDSNRefusals(t *testing.T) {
	withProject(t)
	t.Setenv("YYT_TRACER_LOCAL", "")
	if _, _, err := run(t, tracerConsole(t, nil, nil), "tracer", "dsn", trcMgmtID); err == nil || !strings.Contains(err.Error(), "not configured on this stage") {
		t.Fatalf("no tracer-url: %v", err)
	}
	seatless := tracerConsole(t, nil, map[string]func(recorded) (int, any){
		"GET /tracers/" + trcMgmtID: func(recorded) (int, any) {
			v := sampleTracer(nil)
			delete(v, "writeKey")
			delete(v, "dsn")
			return 200, v
		},
	})
	if _, _, err := run(t, seatless, "tracer", "dsn", trcMgmtID); err == nil || !strings.Contains(err.Error(), "not shown to you") {
		t.Fatalf("seatless admin: %v", err)
	}
	f := tracerConsole(t, sampleDSN, nil)
	n := len(f.reqs)
	if _, _, err := run(t, f, "tracer", "create", "x", "--local", "http://127.0.0.1:8095"); err == nil || !strings.Contains(err.Error(), "goes through the console") {
		t.Fatalf("--local create: %v", err)
	}
	if len(f.reqs) != n {
		t.Fatal("a request was made with --local")
	}
}

func TestLimitTracerScope(t *testing.T) {
	withProject(t)
	f := tracerConsole(t, sampleDSN, map[string]func(recorded) (int, any){
		"GET /limits": func(recorded) (int, any) {
			return 200, map[string]any{"scope": map[string]any{"kind": "tracer", "id": trcMgmtID}, "teamId": "team_1", "limits": []any{}, "pending": []any{}}
		},
		"POST /limit-requests": func(recorded) (int, any) {
			return 201, map[string]any{"id": "lr_1", "status": "pending", "key": "tracer.dailyBytes", "requestedValue": 100 << 20,
				"scope": map[string]any{"kind": "tracer", "id": trcMgmtID, "name": "app-debug"}, "unit": "bytes", "hard": 300 << 20}
		},
	})
	if _, _, err := run(t, f, "limit", "list", "--tracer", "app-debug"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Path; got != "/limits?scope=tracer%3A"+trcMgmtID {
		t.Fatalf("tracer list path = %s", got)
	}
	if _, _, err := run(t, f, "limit", "request", "tracer.dailyBytes", "100MiB", "--tracer", trcMgmtID, "--reason", "quota drops"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Body; got["scope"] != "tracer:"+trcMgmtID || got["value"] != float64(100<<20) {
		t.Fatalf("tracer request body = %v", got)
	}
	// `+50MiB` is the step the tracer-debug skill suggests: it becomes `next`.
	stepped := tracerConsole(t, sampleDSN, map[string]func(recorded) (int, any){
		"GET /limits": func(recorded) (int, any) {
			return 200, map[string]any{"scope": map[string]any{"kind": "tracer", "id": trcMgmtID}, "teamId": "team_1", "pending": []any{},
				"limits": []any{map[string]any{"key": "tracer.dailyBytes", "unit": "bytes", "soft": 50 << 20, "hard": 300 << 20,
					"effective": 50 << 20, "usage": 60 << 20, "step": 50 << 20, "next": 100 << 20, "override": nil}}}
		},
		"POST /limit-requests": func(recorded) (int, any) {
			return 201, map[string]any{"id": "lr_1", "status": "pending", "key": "tracer.dailyBytes", "requestedValue": 100 << 20,
				"scope": map[string]any{"kind": "tracer", "id": trcMgmtID, "name": "app-debug"}, "unit": "bytes", "hard": 300 << 20}
		},
	})
	if _, _, err := run(t, stepped, "limit", "request", "tracer.dailyBytes", "+50MiB", "--tracer", "app-debug", "--reason", "quota drops"); err != nil {
		t.Fatal(err)
	}
	if got := stepped.reqs[len(stepped.reqs)-1].Body["value"]; got != float64(100<<20) {
		t.Fatalf("+50MiB sent %v", got)
	}
	out, _, err := run(t, stepped, "limit", "list", "--tracer", "app-debug")
	if err != nil || !strings.Contains(out, "ask for 100 MiB") || !strings.Contains(out, "tracer.dailyBytes +50MiB") {
		t.Fatalf("step note:\n%s %v", out, err)
	}
	if _, _, err := run(t, stepped, "limit", "request", "tracer.dailyBytes", "+50", "--tracer", "app-debug", "--reason", "r"); err == nil || !strings.Contains(err.Error(), "+50MiB") {
		t.Fatalf("bare number on a size: %v", err)
	}
	if _, _, err := run(t, f, "limit", "list", "--tracer", "app-debug", "--site", "web"); err == nil || !strings.Contains(err.Error(), "--tracer") {
		t.Fatalf("two scopes: %v", err)
	}
}

// A build script embeds what `dsn` prints: anything but the minted shape is refused.
func TestTracerDSNShape(t *testing.T) {
	withProject(t)
	t.Setenv("YYT_TRACER_LOCAL", "")
	key := "0123456789abcdef0123456789abcdef"
	for _, bad := range []string{
		"https://" + key + "@trace-dev.yyt.life/" + trcMgmtID + "\n\x1b]0;pwn\x07",
		"http://" + key + "@trace-dev.yyt.life/" + trcMgmtID,
		"https://ffffffffffffffffffffffffffffffff@trace-dev.yyt.life/" + trcMgmtID,
		"https://" + key + "@trace-dev.yyt.life/trc_other",
		"https://" + key + ":pw@trace-dev.yyt.life/" + trcMgmtID,
		"https://" + key + "@trace-dev.yyt.life/" + trcMgmtID + "?x=1",
	} {
		f := tracerConsole(t, bad, nil)
		out, _, err := run(t, f, "tracer", "dsn", trcMgmtID)
		if err == nil || out != "" || !strings.Contains(err.Error(), "unexpected shape") {
			t.Errorf("%q: out=%q err=%v", bad, out, err)
		}
	}
	// An id typed in capitals is the same resource.
	out, _, err := run(t, tracerConsole(t, sampleDSN, nil), "tracer", "dsn", strings.ToUpper(trcMgmtID[:4])+trcMgmtID[4:])
	if err != nil || out != sampleDSN+"\n" {
		t.Fatalf("upper-case id: %q %v", out, err)
	}
}

// A description cannot forge a line of the resource view.
func TestTracerViewOneLine(t *testing.T) {
	withProject(t)
	t.Setenv("YYT_TRACER_LOCAL", "")
	f := tracerConsole(t, nil, map[string]func(recorded) (int, any){
		"GET /tracers/" + trcMgmtID: func(recorded) (int, any) {
			v := sampleTracer(nil)
			v["description"] = "x\ndsn: https://KEY@evil/trc_x\u009b31m"
			return 200, v
		},
	})
	out, _, err := run(t, f, "tracer", "get", trcMgmtID)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "dsn:") && strings.Contains(l, "evil") {
			t.Fatalf("forged line:\n%s", out)
		}
	}
	if strings.ContainsRune(out, '\u009b') {
		t.Fatalf("C1 control printed:\n%q", out)
	}
	if _, _, err := run(t, f, "tracer", "update", trcMgmtID); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("empty update: %v", err)
	}
}

func TestParseRelative(t *testing.T) {
	for _, c := range []struct {
		in    string
		n     int64
		sized bool
		ok    bool
		err   bool
	}{
		{"+5", 5, false, true, false},
		{"+50MiB", 50 << 20, true, true, false},
		{"50MiB", 0, false, false, false},
		{"+0", 0, false, true, true},
		{"+unlimited", 0, false, true, true},
		{"+5MB", 0, false, true, true},
	} {
		rel, ok, err := parseRelative(c.in)
		if ok != c.ok || (err != nil) != c.err || (err == nil && (rel.n != c.n || rel.sized != c.sized)) {
			t.Errorf("%q: %+v %v %v", c.in, rel, ok, err)
		}
	}
}

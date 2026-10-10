package cmd

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

const sendKey = "KEY-0123456789abcdef-SECRET"

// runIn is `run` with a config file that survives between calls and a stdin.
func runCfg(t *testing.T, f *fakeConsole, cfg, stdin string, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("YYT_CONFIG", cfg)
	t.Setenv("YYT_API", f.srv.URL)
	t.Setenv("YYT_TOKEN", "yyt_test")
	var out, errb bytes.Buffer
	a := &App{Out: &out, Err: &errb, In: strings.NewReader(stdin)}
	root := NewRoot(a)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), errb.String(), err
}

func TestPushSend(t *testing.T) {
	noSleep(t)
	throttles := 1
	var f *fakeConsole
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) {
			return 200, samplePush(map[string]any{"apiBase": f.srv.URL})
		},
		"POST /push/" + pushID + "/send": func(r recorded) (int, any) {
			if throttles > 0 {
				throttles--
				return 503, nil // Lambda throttle: no body, never ran
			}
			return 200, map[string]any{
				"results": []any{
					map[string]any{"userId": "u1", "status": "sent"},
					map[string]any{"userId": "u2", "status": "no-token"},
				},
				"sent": 1, "noToken": 1, "failed": 0,
			}
		},
	}, []any{samplePush(nil)}, nil, nil))
	cfg := filepath.Join(t.TempDir(), "config.json")
	withProject(t)
	if _, _, err := runCfg(t, f, cfg, "", "push", "send", pushID, "--user", "u1", "--title", "hi"); err == nil || !strings.Contains(err.Error(), "push key set") {
		t.Fatalf("no key: %v", err)
	}
	if _, _, err := runCfg(t, f, cfg, sendKey+"\n", "push", "key", "set", pushID); err != nil {
		t.Fatal(err)
	}
	f.reqs = nil
	out, errs, err := runCfg(t, f, cfg, "", "push", "send", pushID, "--user", "u1,u2", "--user", "u1",
		"--data", "kind=invite", "--title", "Party", "--body", "join", "--priority", "high", "--ttl", "600")
	if err != nil {
		t.Fatalf("%v %s", err, errs)
	}
	golden(t, "push_send", out)
	var sends []recorded
	for _, r := range f.reqs {
		if strings.HasSuffix(r.Path, "/send") {
			sends = append(sends, r)
		}
	}
	if len(sends) != 2 {
		t.Fatalf("sends = %d, want a retry after the throttle", len(sends))
	}
	if sends[1].Auth != "Bearer "+sendKey {
		t.Fatalf("auth %q", sends[1].Auth)
	}
	body := sends[1].Body
	if ids := body["userIds"].([]any); len(ids) != 2 {
		t.Fatalf("userIds %v (duplicates must fold)", ids)
	}
	if body["ttlSec"].(float64) != 600 || body["priority"] != "high" {
		t.Fatalf("body %v", body)
	}
	if strings.Contains(out+errs, sendKey) {
		t.Fatal("the key reached the output")
	}
}

func TestPushSendNoRetryOnAnswer(t *testing.T) {
	noSleep(t)
	var f *fakeConsole
	calls := 0
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) {
			return 200, samplePush(map[string]any{"apiBase": f.srv.URL})
		},
		"POST /push/" + pushID + "/send": func(recorded) (int, any) {
			calls++
			return 503, apiErr("unavailable", "push sender unavailable", nil)
		},
	}, nil, nil, nil))
	cfg := filepath.Join(t.TempDir(), "config.json")
	if _, _, err := runCfg(t, f, cfg, sendKey+"\n", "push", "key", "set", pushID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runCfg(t, f, cfg, "", "push", "send", pushID, "--user", "u1", "--data", "a=b"); err == nil {
		t.Fatal("expected the 503")
	}
	if calls != 1 {
		t.Fatalf("a send with an answer was retried (%d calls)", calls)
	}
	if _, _, err := runCfg(t, f, cfg, "", "push", "send", pushID, "--user", "u1"); err == nil || !strings.Contains(err.Error(), "nothing to send") {
		t.Fatalf("empty message: %v", err)
	}
}

func TestPushRotateSave(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /channels/" + pushID + "/rotate-secret": func(recorded) (int, any) {
			return 200, samplePush(map[string]any{"apiKey": sendKey})
		},
	}, nil, nil, nil))
	cfg := filepath.Join(t.TempDir(), "config.json")
	out, errs, err := runCfg(t, f, cfg, "", "push", "channel", "rotate", pushID, "--save")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out+errs, sendKey) {
		t.Fatal("--save printed the key")
	}
	if !strings.Contains(errs, "stored in") {
		t.Fatalf("stderr %q", errs)
	}
	out, _, _ = runCfg(t, f, cfg, "", "push", "key", "ls")
	if strings.TrimSpace(out) != pushID {
		t.Fatalf("ls %q", out)
	}
	// Without --save the key is printed once, as before.
	out, _, _ = runCfg(t, f, cfg, "", "push", "channel", "rotate", pushID)
	if !strings.Contains(out, sendKey) {
		t.Fatal("rotate without --save hid the key")
	}
}

func TestPushJobAsServer(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /push-api/" + pushID + "/jobs": func(recorded) (int, any) {
			return 200, map[string]any{"jobs": []any{}}
		},
	}, nil, nil, nil))
	cfg := filepath.Join(t.TempDir(), "config.json")
	if _, _, err := runCfg(t, f, cfg, "", "push", "job", "ls", pushID, "--as-server"); err == nil || !strings.Contains(err.Error(), "push key set") {
		t.Fatalf("no key: %v", err)
	}
	if _, _, err := runCfg(t, f, cfg, sendKey+"\n", "push", "key", "set", pushID); err != nil {
		t.Fatal(err)
	}
	f.reqs = nil
	if _, errs, err := runCfg(t, f, cfg, "", "push", "job", "ls", pushID, "--as-server"); err != nil {
		t.Fatalf("%v %s", err, errs)
	}
	last := f.reqs[len(f.reqs)-1]
	if !strings.HasPrefix(last.Path, "/push-api/"+pushID+"/jobs") || last.Auth != "Bearer "+sendKey {
		t.Fatalf("request %s %q", last.Path, last.Auth)
	}
}

// --save never costs a secret: refused before anything is issued when the
// channel is not a push channel.
func TestSaveRefusedBeforeIssue(t *testing.T) {
	posted := 0
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /channels/auth_1/rotate-secret": func(recorded) (int, any) {
			posted++
			return 200, map[string]any{"id": "auth_1", "kind": "auth", "secret": "S"}
		},
		"POST /projects/prj_1/channels": func(recorded) (int, any) { posted++; return 201, map[string]any{"id": "auth_2", "kind": "auth"} },
	}, nil, nil, nil))
	withProject(t)
	if _, _, err := run(t, f, "channels", "rotate-secret", "auth_1", "--save"); err == nil || !strings.Contains(err.Error(), "--save") {
		t.Fatalf("rotate: %v", err)
	}
	if _, _, err := run(t, f, "channels", "create", "--kind", "auth", "--name", "a", "--audience", "g", "--save"); err == nil || !strings.Contains(err.Error(), "--save") {
		t.Fatalf("create: %v", err)
	}
	if posted != 0 {
		t.Fatalf("%d secrets issued and lost", posted)
	}
}

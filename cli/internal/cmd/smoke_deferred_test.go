package cmd

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeJWT(sub string) string {
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"HS256"}`)) + "." + enc([]byte(`{"sub":"`+sub+`"}`)) + ".sig"
}

func TestSmokeMatchDeferred(t *testing.T) {
	noSleep(t)
	accepted := map[string]bool{}
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /m/match_1/ticket": func(recorded) (int, any) { return 200, map[string]any{"state": "waiting", "position": 1} },
		"GET /m/match_1/ticket": func(r recorded) (int, any) {
			if len(accepted) == 2 {
				return 200, map[string]any{"state": "confirmed", "matchId": "m1", "members": []any{}}
			}
			return 200, map[string]any{"state": "proposed", "matchId": "m1", "accepted": accepted[r.Auth]}
		},
		"POST /m/match_1/accept": func(r recorded) (int, any) {
			accepted[r.Auth] = true
			return 200, map[string]any{"state": "proposed", "matchId": "m1", "accepted": true}
		},
	})
	out, errs, err := run(t, f, "smoke", "match", "--deferred", "--url", f.srv.URL+"/m/match_1/ticket",
		"--jwt", fakeJWT("a"), "--jwt", fakeJWT("b"))
	if err != nil {
		t.Fatalf("%v\n%s%s", err, out, errs)
	}
	if !strings.Contains(errs, "ok: 2 players confirmed") {
		t.Fatalf("stderr %q", errs)
	}
	if strings.Contains(out, fakeJWT("a")) {
		t.Fatal("a JWT reached the output")
	}
	// A WebSocket URL is still refused with --deferred off.
	if _, _, err := run(t, f, "smoke", "match", "--url", f.srv.URL+"/m/match_1/ticket", "--jwt", fakeJWT("a")); err == nil || !strings.Contains(err.Error(), "--deferred") {
		t.Fatalf("live mode with a ticketUrl: %v", err)
	}
}

func TestSmokeMatchDeferredFails(t *testing.T) {
	noSleep(t)
	deleted := 0
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /m/match_1/ticket":   func(recorded) (int, any) { return 200, map[string]any{"state": "waiting"} },
		"GET /m/match_1/ticket":    func(recorded) (int, any) { return 200, map[string]any{"state": "expired", "reason": "wait"} },
		"DELETE /m/match_1/ticket": func(recorded) (int, any) { deleted++; return 204, nil },
	})
	_, _, err := run(t, f, "smoke", "match", "--deferred", "--url", f.srv.URL+"/m/match_1/ticket", "--jwt", fakeJWT("a"))
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("err %v", err)
	}
	if deleted != 1 {
		t.Fatalf("tickets deleted: %d", deleted)
	}
}

func TestSmokePush(t *testing.T) {
	noSleep(t)
	var f *fakeConsole
	var put, del int
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) {
			return 200, samplePush(map[string]any{"apiBase": f.srv.URL})
		},
		"PUT /push/" + pushID + "/token":    func(recorded) (int, any) { put++; return 204, nil },
		"DELETE /push/" + pushID + "/token": func(recorded) (int, any) { del++; return 204, nil },
		"POST /push/" + pushID + "/send": func(r recorded) (int, any) {
			return 200, map[string]any{"results": []any{map[string]any{"userId": "p1", "status": "sent"}}, "sent": 1}
		},
	}, nil, nil, nil))
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.json")
	tok := filepath.Join(dir, "fcm")
	_ = os.WriteFile(tok, []byte("FCM-TOKEN-MARKER\n"), 0o600)
	if _, _, err := runCfg(t, f, cfg, sendKey+"\n", "push", "key", "set", pushID); err != nil {
		t.Fatal(err)
	}
	f.reqs = nil
	out, errs, err := runCfg(t, f, cfg, "", "smoke", "push", pushID, "--jwt", fakeJWT("p1"), "--token-file", tok)
	if err != nil {
		t.Fatalf("%v %s", err, errs)
	}
	if put != 1 || del != 1 {
		t.Fatalf("put %d del %d", put, del)
	}
	for _, r := range f.reqs {
		if strings.HasSuffix(r.Path, "/send") && r.Auth != "Bearer "+sendKey {
			t.Fatal("send without the key")
		}
		if strings.HasSuffix(r.Path, "/token") && r.Auth != "Bearer "+fakeJWT("p1") {
			t.Fatal("token route without the JWT")
		}
	}
	all := out + errs
	for _, secret := range []string{"FCM-TOKEN-MARKER", sendKey, fakeJWT("p1")} {
		if strings.Contains(all, secret) {
			t.Fatalf("%q reached the output", secret)
		}
	}
}

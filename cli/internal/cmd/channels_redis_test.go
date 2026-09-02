package cmd

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChannelsRedisUser(t *testing.T) {
	block := map[string]any{
		"channelId":        "q_0123",
		"host":             "redis.example",
		"port":             6379,
		"username":         "game_dev_q_0123",
		"eventKeyPrefix":   "game:dev:q_0123:event:",
		"queueKeyPrefix":   "game:dev:q_0123:queue:",
		"lockKeyPrefix":    "game:dev:q_0123:lock:",
		"awaiterKeyPrefix": "game:dev:q_0123:awaiter:",
		"channelPrefix":    "game:out:dev:q_0123:",
	}
	show := map[string]any{"issued": false}
	issued := map[string]any{"password": strings.Repeat("ab", 32)}
	for k, v := range block {
		show[k] = v
		issued[k] = v
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /channels/q_0123/redis-user":    func(recorded) (int, any) { return 200, show },
		"POST /channels/q_0123/redis-user":   func(recorded) (int, any) { return 200, issued },
		"DELETE /channels/q_0123/redis-user": func(recorded) (int, any) { return 200, map[string]any{"revoked": true} },
	})

	out, _, err := run(t, f, "channels", "redis-user", "show", "q_0123")
	if err != nil {
		t.Fatal(err)
	}
	// The four prefixes tslib's handleActor needs must all be printed: one the
	// participant invents instead lands outside the ACL and fails NOPERM.
	for _, want := range []string{"issued", "false", "game:dev:q_0123:event:", "game:dev:q_0123:queue:", "game:dev:q_0123:lock:", "game:dev:q_0123:awaiter:", "game:out:dev:q_0123:", "game_dev_q_0123"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	if strings.Contains(out, "password") {
		t.Fatalf("show must not print a password: %s", out)
	}

	out, errOut, err := run(t, f, "channels", "redis-user", "issue", "q_0123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, strings.Repeat("ab", 32)) {
		t.Fatalf("issue must print the password once: %s", out)
	}
	if !strings.Contains(errOut, "not shown again") {
		t.Fatalf("issue must warn: %q", errOut)
	}

	out, _, err = run(t, f, "channels", "redis-user", "revoke", "q_0123")
	if err != nil || out != "revoked the redis account of q_0123\n" {
		t.Fatalf("%v %q", err, out)
	}

	none := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /channels/q_0123/redis-user": func(recorded) (int, any) { return 200, map[string]any{"revoked": false} },
	})
	out, _, err = run(t, none, "channels", "redis-user", "revoke", "q_0123")
	if err != nil || out != "q_0123 had no redis account\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestChannelsRedisUserDegradedStates(t *testing.T) {
	block := map[string]any{
		"channelId": "q_0123", "host": "redis.example", "port": 6379,
		"username":       "game_dev_q_0123",
		"queueKeyPrefix": "game:dev:q_0123:queue:",
	}
	unconfigured := map[string]any{"configured": false}
	notPersisted := map[string]any{"password": strings.Repeat("cd", 32), "persisted": false}
	for k, v := range block {
		unconfigured[k] = v
		notPersisted[k] = v
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /channels/q_0123/redis-user":  func(recorded) (int, any) { return 200, unconfigured },
		"POST /channels/q_0123/redis-user": func(recorded) (int, any) { return 200, notPersisted },
	})

	// A stage without an issuer must not read as "not issued yet": the CLI
	// cannot know, and printing `false` would send someone hunting a bug.
	out, _, err := run(t, f, "channels", "redis-user", "show", "q_0123")
	if err != nil || !strings.Contains(out, "no issuer account") {
		t.Fatalf("%v %q", err, out)
	}

	// A credential that is live but absent from the ACL file must say so, or
	// it silently stops working at the next Redis restart.
	out, errOut, err := run(t, f, "channels", "redis-user", "issue", "q_0123")
	if err != nil || !strings.Contains(out, strings.Repeat("cd", 32)) {
		t.Fatalf("%v %q", err, out)
	}
	if !strings.Contains(errOut, "not persisted") {
		t.Fatalf("missing warning: %q", errOut)
	}
}

func TestCredentialRevokeJSON(t *testing.T) {
	f := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /channels/q_1/redis-user": func(recorded) (int, any) { return 200, map[string]any{"revoked": true} },
		"DELETE /channels/auth_1/doc-key": func(recorded) (int, any) { return 200, map[string]any{"revoked": false} },
	})
	for _, tc := range []struct {
		args []string
		want bool
	}{
		{[]string{"channels", "redis-user", "revoke", "q_1", "--json"}, true},
		{[]string{"channels", "doc-key", "revoke", "auth_1", "--json"}, false},
	} {
		out, _, err := run(t, f, tc.args...)
		if err != nil {
			t.Fatal(err)
		}
		var j map[string]any
		if json.Unmarshal([]byte(out), &j) != nil || j["revoked"] != tc.want {
			t.Fatalf("%v: %s", tc.args, out)
		}
	}
}

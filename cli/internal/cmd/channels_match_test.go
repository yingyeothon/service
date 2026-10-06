package cmd

import (
	"strings"
	"testing"
)

// matchFixture is a match channel view. A live channel is stored without
// `mode` and has a socket; a deferred one has its own fields and a ticket URL.
func matchFixture(id, name string, deferred bool) map[string]any {
	m := map[string]any{}
	for k, v := range sampleChannel {
		m[k] = v
	}
	for _, k := range []string{"issuer", "startUrl", "callbackUrls"} {
		delete(m, k)
	}
	m["id"], m["kind"], m["name"] = id, "match", name
	cfg := map[string]any{"authChannelId": "auth_0123", "partySize": 2, "waitTimeoutSec": 60, "onTimeout": "fail"}
	if deferred {
		cfg["mode"], cfg["waitTimeoutSec"] = "deferred", 900
		cfg["acceptTimeoutSec"], cfg["resultTtlSec"], cfg["pushChannelId"] = 45, 1200, "push_0123"
		m["apiBase"] = "https://match-api.example"
		m["ticketUrl"] = "https://match-api.example/m/" + id + "/ticket"
	} else {
		m["wsUrl"] = "wss://match.example/?channel=" + id
	}
	m["config"] = cfg
	return m
}

var matchPush = map[string]any{"id": "push_0123", "kind": "push", "name": "alerts"}

func badRequest(message string, details any) (int, any) {
	e := map[string]any{"code": "bad_request", "message": message}
	if details != nil {
		e["details"] = details
	}
	return 400, map[string]any{"error": e}
}

func TestChannelsMatchModeListAndGet(t *testing.T) {
	live, deferred := matchFixture("match_live", "duel", false), matchFixture("match_def", "league", true)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/match_live": func(recorded) (int, any) { return 200, live },
		"GET /channels/match_def":  func(recorded) (int, any) { return 200, deferred },
	}, []any{sampleChannel, live, deferred}, nil, nil))

	out, _, err := run(t, f, "channels", "list", "--project", "prj_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "channels_match_list", out)

	out, _, err = run(t, f, "channels", "get", "match_def")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "channels_match_get", out)

	// A live channel says its mode and keeps its socket; nothing deferred.
	out, _, err = run(t, f, "channels", "get", "match_live")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "mode:    live\n") || !strings.Contains(out, "wsUrl:   wss://match.example/?channel=match_live\n") {
		t.Errorf("live view:\n%s", out)
	}
	for _, k := range []string{"ticketUrl", "pushChannel", "acceptTimeoutSec"} {
		if strings.Contains(out, k+":") {
			t.Errorf("live view prints %s:\n%s", k, out)
		}
	}

	// A stage without the match HTTP host hands out no URL, and the view says so.
	delete(deferred, "ticketUrl")
	delete(deferred["config"].(map[string]any), "pushChannelId")
	out, _, err = run(t, f, "channels", "get", "match_def")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ticketUrl:        none (the match service has no HTTP host on this stage)", "pushChannel:      none (clients poll their ticket)"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "acceptUrl") {
		t.Errorf("routes without a host:\n%s", out)
	}
	// --json is the resource itself: no derived keys.
	out, _, err = run(t, f, "channels", "get", "match_live", "--json")
	if err != nil || strings.Contains(out, `"mode"`) || !strings.Contains(out, `"wsUrl"`) {
		t.Errorf("json: %v\n%s", err, out)
	}
}

func TestChannelsMatchModeCreate(t *testing.T) {
	var created map[string]any
	var pushListed string
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1/channels": func(r recorded) (int, any) {
			if strings.Contains(r.Path, "kind=push") {
				pushListed = r.Path
				return 200, map[string]any{"channels": []any{matchPush}}
			}
			return 200, map[string]any{"channels": []any{sampleChannel, matchPush}}
		},
		"POST /projects/prj_1/channels": func(r recorded) (int, any) {
			created = r.Body
			return 201, matchFixture("match_new", "league", true)
		},
	}, nil, nil, nil))
	withProject(t)
	config := func() map[string]any { return created["config"].(map[string]any) }

	// --push-channel takes a name, looked up among the project's push channels.
	out, _, err := run(t, f, "channels", "create", "--kind", "match", "--name", "league", "--auth-channel", "demo",
		"--party-size", "2", "--mode", "deferred", "--wait-timeout", "900", "--accept-timeout", "45",
		"--result-ttl", "1200", "--push-channel", "ALERTS")
	if err != nil {
		t.Fatal(err)
	}
	c := config()
	if c["mode"] != "deferred" || c["waitTimeoutSec"] != float64(900) || c["acceptTimeoutSec"] != float64(45) ||
		c["resultTtlSec"] != float64(1200) || c["pushChannelId"] != "push_0123" || c["authChannelId"] != "auth_0123" {
		t.Fatalf("config %v", c)
	}
	if pushListed != "/projects/prj_1/channels?kind=push" {
		t.Errorf("push lookup = %q", pushListed)
	}
	if !strings.Contains(out, "ticketUrl:        https://match-api.example/m/match_new/ticket\n") {
		t.Errorf("create view:\n%s", out)
	}

	// Defaults are the server's: only what was given is sent, and an id is not looked up.
	pushListed = ""
	if _, _, err := run(t, f, "channels", "create", "--kind", "match", "--name", "l2", "--auth-channel", "auth_0123",
		"--party-size", "2", "--mode", "deferred", "--push-channel", "push_0123"); err != nil {
		t.Fatal(err)
	}
	c = config()
	if len(c) != 4 || c["mode"] != "deferred" || c["pushChannelId"] != "push_0123" || pushListed != "" {
		t.Fatalf("config %v, lookup %q", c, pushListed)
	}
	// An empty --push-channel on create means none: the key is left out.
	if _, _, err := run(t, f, "channels", "create", "--kind", "match", "--name", "l3", "--auth-channel", "auth_0123",
		"--party-size", "2", "--mode", "deferred", "--push-channel", ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := config()["pushChannelId"]; ok {
		t.Fatalf("config %v", config())
	}
	// A live channel is created as before the flag existed, with or without it.
	if _, _, err := run(t, f, "channels", "create", "--kind", "match", "--name", "l4", "--auth-channel", "auth_0123",
		"--party-size", "2", "--mode", "live"); err != nil {
		t.Fatal(err)
	}
	if c = config(); c["mode"] != "live" || len(c) != 3 {
		t.Fatalf("config %v", c)
	}

	// What the console would refuse is refused before any write.
	base := []string{"channels", "create", "--kind", "match", "--name", "x", "--auth-channel", "auth_0123", "--party-size", "2"}
	created = nil
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--mode", "later"}, "--mode must be live|deferred"},
		{[]string{"--accept-timeout", "60"}, "--accept-timeout belongs to a deferred match channel"},
		{[]string{"--mode", "live", "--result-ttl", "600"}, "--result-ttl belongs to a deferred match channel"},
		{[]string{"--push-channel", "alerts"}, "--push-channel belongs to a deferred match channel"},
		{[]string{"--mode", "deferred", "--push-channel", "auth_0123"}, "auth_0123 is not a push channel"},
		{[]string{"--mode", "deferred", "--push-channel", "nope"}, `--push-channel: not_found: channel "nope" not found`},
	} {
		_, _, err := run(t, f, append(append([]string{}, base...), tc.args...)...)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: err=%v, want %q", tc.args, err, tc.want)
		}
	}
	if created != nil {
		t.Fatal("a refused create must not POST")
	}
	// A deferred flag on another kind is foreign, like every other.
	if _, _, err := run(t, f, "channels", "create", "--kind", "topic", "--name", "t", "--auth-channel", "auth_0123",
		"--mode", "deferred"); err == nil || !strings.Contains(err.Error(), "--mode does not apply to a topic channel") {
		t.Errorf("foreign flag: %v", err)
	}
}

func TestChannelsMatchModeUpdate(t *testing.T) {
	live, deferred := matchFixture("match_live", "duel", false), matchFixture("match_def", "league", true)
	var patched map[string]any
	var refuse func() (int, any)
	patch := func(view map[string]any) func(recorded) (int, any) {
		return func(r recorded) (int, any) {
			patched = r.Body
			if refuse != nil {
				return refuse()
			}
			return 200, view
		}
	}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/match_live":   func(recorded) (int, any) { return 200, live },
		"GET /channels/match_def":    func(recorded) (int, any) { return 200, deferred },
		"PATCH /channels/match_live": patch(live),
		"PATCH /channels/match_def":  patch(deferred),
	}, []any{sampleChannel, matchPush}, nil, nil))
	config := func() map[string]any { return patched["config"].(map[string]any) }

	// The PATCH is a full replace: one flag goes out on top of everything
	// stored, the mode and the deferred fields included.
	if _, _, err := run(t, f, "channels", "update", "match_def", "--party-size", "4"); err != nil {
		t.Fatal(err)
	}
	c := config()
	if c["partySize"] != float64(4) || c["mode"] != "deferred" || c["waitTimeoutSec"] != float64(900) ||
		c["acceptTimeoutSec"] != float64(45) || c["resultTtlSec"] != float64(1200) || c["pushChannelId"] != "push_0123" {
		t.Fatalf("config %v", c)
	}
	// A deferred flag changes its own field only; naming the stored mode is allowed.
	if _, _, err := run(t, f, "channels", "update", "match_def", "--mode", "deferred", "--accept-timeout", "90"); err != nil {
		t.Fatal(err)
	}
	if c = config(); c["acceptTimeoutSec"] != float64(90) || c["resultTtlSec"] != float64(1200) || c["pushChannelId"] != "push_0123" {
		t.Fatalf("config %v", c)
	}
	// --push-channel '' removes the link and nothing else; a name resolves.
	if _, _, err := run(t, f, "channels", "update", "match_def", "--push-channel", ""); err != nil {
		t.Fatal(err)
	}
	c = config()
	if _, ok := c["pushChannelId"]; ok || c["mode"] != "deferred" || c["acceptTimeoutSec"] != float64(45) {
		t.Fatalf("config %v", c)
	}
	if _, _, err := run(t, f, "channels", "update", "match_def", "--push-channel", "alerts", "--project", "prj_1"); err != nil {
		t.Fatal(err)
	}
	if c = config(); c["pushChannelId"] != "push_0123" {
		t.Fatalf("config %v", c)
	}
	// A live channel's update still carries no mode.
	if _, _, err := run(t, f, "channels", "update", "match_live", "--wait-timeout", "30", "--push-channel", ""); err != nil {
		t.Fatal(err)
	}
	if c = config(); len(c) != 4 || c["waitTimeoutSec"] != float64(30) {
		t.Fatalf("config %v", c)
	}

	// The mode is fixed, and a deferred flag means nothing on a live channel:
	// both stop after the read.
	patched = nil
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"match_def", "--mode", "live"}, "this is a deferred channel and the mode is fixed at creation"},
		{[]string{"match_live", "--mode", "deferred"}, "this is a live channel and the mode is fixed at creation"},
		{[]string{"match_live", "--accept-timeout", "60"}, "--accept-timeout belongs to a deferred match channel"},
		{[]string{"match_live", "--push-channel", "push_0123"}, "--push-channel belongs to a deferred match channel"},
		{[]string{"match_def", "--push-channel", "auth_0123"}, "auth_0123 is not a push channel"},
	} {
		_, _, err := run(t, f, append([]string{"channels", "update"}, tc.args...)...)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: err=%v, want %q", tc.args, err, tc.want)
		}
	}
	if patched != nil {
		t.Fatal("a refused update must not PATCH")
	}

	// The console's own refusals come back with the next step.
	issue := func(path, message string) []any {
		return []any{map[string]any{"path": path, "message": message}}
	}
	for _, tc := range []struct {
		refuse func() (int, any)
		args   []string
		want   string
	}{
		{func() (int, any) {
			return badRequest("pushChannelId is not an active push channel of this project on the same auth channel", nil)
		}, []string{"match_def", "--push-channel", "push_0999"}, "`yyt push channel list`"},
		{func() (int, any) {
			return badRequest("invalid config", issue("waitTimeoutSec", "waitTimeoutSec must be 30..7200 on a deferred channel"))
		}, []string{"match_def", "--wait-timeout", "5"}, "5..600 on a live channel and 30..7200 on a deferred one"},
		{func() (int, any) { return badRequest("mode cannot be changed after creation", nil) },
			[]string{"match_def", "--config", `{"authChannelId":"auth_0123","partySize":2,"mode":"live"}`}, "the mode is fixed at creation"},
		// The stable reason decides, whatever the message says; the message
		// above is read only when an older server sent no reason.
		{func() (int, any) {
			return badRequest("reworded by the server", map[string]any{"reason": "push_channel_unusable"})
		}, []string{"match_def", "--push-channel", "push_0999"}, "`yyt push channel list`"},
		{func() (int, any) {
			return badRequest("reworded by the server", map[string]any{"reason": "mode_fixed"})
		}, []string{"match_def", "--config", `{"authChannelId":"auth_0123","partySize":2,"mode":"live"}`}, "the mode is fixed at creation"},
		{func() (int, any) {
			return badRequest("pushChannelId is not an active push channel", map[string]any{"reason": "mode_fixed"})
		}, []string{"match_def", "--push-channel", "push_0999"}, "the mode is fixed at creation"},
		{func() (int, any) {
			return badRequest("invalid config", issue("resultTtlSec", "resultTtlSec belongs to a deferred channel"))
		}, []string{"match_live", "--config", `{"authChannelId":"auth_0123","partySize":2,"resultTtlSec":600}`}, "need a deferred channel"},
	} {
		refuse = tc.refuse
		_, _, err := run(t, f, append([]string{"channels", "update"}, tc.args...)...)
		if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "bad_request") {
			t.Errorf("%v: err=%v, want %q", tc.args, err, tc.want)
		}
	}
}

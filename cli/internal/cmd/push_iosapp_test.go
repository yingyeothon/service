package cmd

import (
	"os"
	"strings"
	"testing"
)

// samplePushIOS is samplePush with an iOS app in the given state.
func samplePushIOS(sender, apns string, registered bool) map[string]any {
	return samplePush(map[string]any{
		"config":        map[string]any{"authChannelId": "auth_0123", "packageName": "com.example.game", "sender": sender, "iosBundleId": "com.example.game-ios"},
		"iosRegistered": registered, "apnsState": apns, "registered": sender == "platform",
	})
}

func TestPushCreateIOSBundleID(t *testing.T) {
	var body map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/channels": func(r recorded) (int, any) {
			body = r.Body
			return 201, samplePushIOS("platform", "pending", true)
		},
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
	}, []any{sampleChannel}, nil, nil))
	withProject(t)

	for _, args := range [][]string{
		{"push", "channel", "create", "--name", "alerts", "--auth", "auth_0123", "--package", "com.example.game", "--ios-bundle-id", "com.example.game-ios"},
		{"channels", "create", "--kind", "push", "--name", "alerts", "--auth-channel", "auth_0123", "--package", "com.example.game", "--ios-bundle-id", "com.example.game-ios"},
	} {
		body = nil
		out, _, err := run(t, f, args...)
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		cfg, _ := body["config"].(map[string]any)
		if cfg["iosBundleId"] != "com.example.game-ios" || len(cfg) != 3 {
			t.Errorf("%v: config = %v", args, cfg)
		}
		if !strings.Contains(out, "ios:") || !strings.Contains(out, "apns:") || !strings.Contains(out, "pending (") {
			t.Errorf("%v: out = %s", args, out)
		}
	}

	// The grammar is checked before any request; the bundle id is fixed once
	// set, so update points at `ios add`.
	f.reqs = nil
	base := []string{"push", "channel", "create", "--name", "alerts", "--auth", "auth_0123", "--package", "com.example.game", "--ios-bundle-id"}
	for _, bad := range []string{"game", "com..game", "com.exa_mple", ".com.game", "com.game.", "a." + strings.Repeat("b", 154)} {
		if _, _, err := run(t, f, append(append([]string{}, base...), bad)...); err == nil || !strings.Contains(err.Error(), "--ios-bundle-id") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	for _, args := range [][]string{
		{"channels", "update", pushID, "--ios-bundle-id", "com.example.game"},
		{"channels", "create", "--kind", "auth", "--name", "a", "--ios-bundle-id", "com.example.game"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Errorf("%v: accepted", args)
		}
	}
	if _, _, err := run(t, f, "push", "channel", "update", pushID, "--ios-bundle-id", "com.example.game"); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("push channel update --ios-bundle-id: %v", err)
	}
	for _, r := range f.reqs {
		if r.Method != "GET" {
			t.Errorf("a refused flag sent %s %s", r.Method, r.Path)
		}
	}
}

func TestPushIOSAdd(t *testing.T) {
	var put map[string]any
	status, sender := 200, "platform"
	var details map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
		"PUT /channels/" + pushID + "/push/ios": func(r recorded) (int, any) {
			put = r.Body
			if status != 200 {
				return status, apiErr("refused", "no", details)
			}
			if sender == "team" {
				return 200, samplePushIOS("team", "team", false)
			}
			return 200, samplePushIOS("platform", "pending", true)
		},
	}, []any{samplePush(nil)}, nil, nil))
	withProject(t)

	out, _, err := run(t, f, "push", "channel", "ios", "add", pushID, "com.example.game-ios")
	if err != nil {
		t.Fatal(err)
	}
	if put["iosBundleId"] != "com.example.game-ios" || len(put) != 1 {
		t.Errorf("body = %v", put)
	}
	golden(t, "push_channel_ios_add", out)
	sender = "team"
	out, _, err = run(t, f, "push", "channel", "ios", "add", "alerts", "com.example.game-ios")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_channel_ios_team", out)
	out, _, err = run(t, f, "push", "channel", "ios", "add", pushID, "com.example.game-ios", "--json")
	if err != nil || !strings.Contains(out, `"apnsState": "team"`) || !strings.Contains(out, `"iosRegistered": false`) {
		t.Errorf("--json: %v\n%s", err, out)
	}

	// Refused locally: no request.
	f.reqs = nil
	if _, _, err := run(t, f, "push", "channel", "ios", "add", pushID, "not a bundle"); err == nil || !strings.Contains(err.Error(), "not an iOS bundle id") {
		t.Errorf("bad bundle: %v", err)
	}
	if _, _, err := run(t, f, "push", "channel", "ios", "add", pushID); err == nil {
		t.Error("a missing bundle id must fail")
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests: %v", f.reqs)
	}

	for _, c := range []struct {
		status int
		reason string
		want   string
	}{
		{409, "ios_immutable", "its bundle id cannot change"},
		{409, "bundle_taken", "another push channel on this stage holds that bundle id"},
		{409, "not_registered", "Firebase registration is not finished"},
		{503, "push_slot_full", "no room for an iOS app"},
		{400, "bundle_refused", "Firebase refused the bundle id"},
	} {
		status, details = c.status, map[string]any{"reason": c.reason}
		_, _, err := run(t, f, "push", "channel", "ios", "add", pushID, "com.example.game-ios")
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.reason, err)
		}
		if c.reason == "not_registered" && err != nil && strings.Contains(err.Error(), "own Firebase project") {
			t.Errorf("not_registered borrowed the download's hint: %v", err)
		}
	}
}

func TestPushChannelConfigIOS(t *testing.T) {
	const plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>BUNDLE_ID</key><string>com.example.game-ios</string></dict></plist>\n"
	registered, html := true, false
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID: func(recorded) (int, any) { return 200, samplePush(nil) },
		"GET /channels/" + pushID + "/GoogleService-Info.plist": func(recorded) (int, any) {
			if html {
				return 200, rawBody{"text/html", "<html>\x1b[31mnot the console</html>"}
			}
			if !registered {
				return 409, apiErr("conflict", "the channel has no platform iOS registration", map[string]any{"reason": "not_registered"})
			}
			return 200, rawBody{"application/x-plist", plist}
		},
	}, nil, nil, nil))
	t.Chdir(t.TempDir())

	out, errs, err := run(t, f, "push", "channel", "config", pushID, "--ios")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile("GoogleService-Info.plist")
	if string(got) != plist || out != "" || !strings.Contains(errs, "wrote GoogleService-Info.plist (") {
		t.Errorf("file = %q, out = %q, err = %q", got, out, errs)
	}
	if _, err := os.Stat("google-services.json"); err == nil {
		t.Error("--ios wrote the Android file")
	}
	// Kept unless --force, before any request.
	f.reqs = nil
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "--ios"); err == nil || !strings.Contains(err.Error(), "GoogleService-Info.plist exists") || len(f.reqs) != 0 {
		t.Errorf("overwrite: %v %v", err, f.reqs)
	}
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "--ios", "--force"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "--ios", "-o", "app.plist"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile("app.plist"); string(got) != plist {
		t.Errorf("-o file = %q", got)
	}
	out, errs, err = run(t, f, "push", "channel", "config", pushID, "--ios", "-o", "-")
	if err != nil || out != plist || errs != "" {
		t.Errorf("stdout: %v %q %q", err, out, errs)
	}
	// Not a plist (a wrong --api): nothing written, nothing printed.
	html = true
	for _, o := range []string{"html.plist", "-"} {
		out, _, err := run(t, f, "push", "channel", "config", pushID, "--ios", "-o", o)
		if err == nil || !strings.Contains(err.Error(), "did not answer with a plist") || out != "" {
			t.Errorf("-o %s: html: %v %q", o, err, out)
		}
	}
	html = false
	registered = false
	if _, _, err := run(t, f, "push", "channel", "config", pushID, "--ios", "-o", "none.plist"); err == nil ||
		!strings.Contains(err.Error(), "push channel ios add") || !strings.Contains(err.Error(), "own Firebase project") {
		t.Errorf("not_registered: %v", err)
	}
	if entries, _ := os.ReadDir("."); len(entries) != 2 {
		t.Errorf("leftovers: %v", entries)
	}
}

func TestPushPoolAPNs(t *testing.T) {
	var posted map[string]any
	var refuse map[string]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /admin/push/pool": func(recorded) (int, any) {
			return 200, map[string]any{"configured": true, "slots": []any{
				map[string]any{"slot": "p1", "provisioned": true, "closed": false, "closedBy": nil, "closedByLogin": nil, "closedAt": nil, "apps": 4, "capacity": 20},
			}, "apnsPending": []any{
				map[string]any{"channelId": pushID, "teamId": "team_1", "iosBundleId": "com.example.game-ios", "slot": "p1"},
			}}
		},
		"POST /admin/push/channels/" + pushID + "/apns": func(r recorded) (int, any) {
			posted = r.Body
			if refuse != nil {
				return 409, apiErr("conflict", "no", refuse)
			}
			return 200, map[string]any{"channelId": pushID, "apnsState": r.Body["state"]}
		},
		"POST /admin/push/channels/push_gone/apns": func(recorded) (int, any) {
			return 404, apiErr("not_found", "push channel not found", nil)
		},
	})
	out, errs, err := run(t, f, "push", "pool")
	if err != nil || errs != "" {
		t.Fatal(err, errs)
	}
	golden(t, "push_pool_apns", out)
	out, _, err = run(t, f, "push", "pool", "--json")
	if err != nil || !strings.Contains(out, `"iosBundleId": "com.example.game-ios"`) {
		t.Errorf("--json: %v\n%s", err, out)
	}

	out, _, err = run(t, f, "push", "pool", "apns", pushID, "ready")
	if err != nil || out != "apns ready on "+pushID+"\n" || posted["state"] != "ready" || len(posted) != 1 {
		t.Errorf("ready: %v %q %v", err, out, posted)
	}
	out, _, err = run(t, f, "push", "pool", "apns", pushID, "pending", "--json")
	if err != nil || !strings.Contains(out, `"apnsState": "pending"`) {
		t.Errorf("pending --json: %v %q", err, out)
	}
	if _, _, err := run(t, f, "push", "pool", "apns", "push_gone", "ready"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("unknown: %v", err)
	}
	for reason, want := range map[string]string{"ios_not_registered": "has no iOS app", "team_sender": "team's own Firebase project"} {
		refuse = map[string]any{"reason": reason}
		if _, _, err := run(t, f, "push", "pool", "apns", pushID, "ready"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", reason, err)
		}
	}

	f.reqs = nil
	for _, args := range [][]string{{pushID, "done"}, {"alerts", "ready"}, {pushID}} {
		if _, _, err := run(t, f, append([]string{"push", "pool", "apns"}, args...)...); err == nil {
			t.Errorf("%v: accepted", args)
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests: %v", f.reqs)
	}
}

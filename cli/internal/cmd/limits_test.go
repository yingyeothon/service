package cmd

import (
	"strings"
	"testing"
	"time"
)

func TestParseLimitValue(t *testing.T) {
	for in, want := range map[string]any{
		"unlimited": "unlimited",
		"Unlimited": "unlimited",
		"400":       int64(400),
		"256MiB":    int64(256 << 20),
		"3 GiB":     int64(3 << 30),
		"512kib":    int64(512 << 10),
		"10B":       int64(10),
	} {
		got, err := parseLimitValue(in)
		if err != nil || got != want {
			t.Errorf("parseLimitValue(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "0", "-1", "64MB", "1.5GiB", "9999999999GiB", "lots"} {
		if _, err := parseLimitValue(bad); err == nil {
			t.Errorf("parseLimitValue(%q) accepted", bad)
		}
	}
	for in, want := range map[string]time.Duration{"7d": 7 * 24 * time.Hour, "12h": 12 * time.Hour, "90m": 90 * time.Minute} {
		got, err := parseSpan(in)
		if err != nil || got != want {
			t.Errorf("parseSpan(%q) = %v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"0d", "-3h", "week"} {
		if _, err := parseSpan(bad); err == nil {
			t.Errorf("parseSpan(%q) accepted", bad)
		}
	}
	if got := formatLimit("bytes", float64(20<<20)); got != "20 MiB" {
		t.Errorf("formatLimit bytes = %q", got)
	}
	if got := formatLimit("bytes", float64(1000)); got != "1000 B" {
		t.Errorf("formatLimit small = %q", got)
	}
	if got := formatLimit("seconds", float64(28*86400)); got != "28 days" {
		t.Errorf("formatLimit seconds = %q", got)
	}
	if got := formatLimit("count", float64(50)); got != "50" {
		t.Errorf("formatLimit count = %q", got)
	}
}

var limitBundle = map[string]any{"id": "ab_1", "name": "maps", "teamId": "team_1", "projectId": "prj_1", "createdAt": 1756000000, "updatedAt": 1756000000}

var sampleRequest = map[string]any{
	"id": "lr_01k", "teamId": "team_1", "teamName": "dooroo",
	"scope": map[string]any{"kind": "bundle", "id": "ab_1", "name": "maps"},
	"key":   "asset.fileBytes", "unit": "bytes", "requestedValue": 64 << 20, "reason": "music packs",
	"status": "pending", "decidedValue": nil, "decisionNote": nil,
	"createdBy": "m_octo", "createdByLogin": "octo", "createdAt": 1756000000,
	"decidedBy": nil, "decidedByLogin": nil, "decidedAt": nil,
}

func TestLimitListAndRequest(t *testing.T) {
	withProject(t)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /limits": func(r recorded) (int, any) {
			return 200, map[string]any{
				"scope": map[string]any{"kind": "bundle", "id": "ab_1"}, "teamId": "team_1",
				"limits": []any{
					map[string]any{"key": "asset.fileBytes", "unit": "bytes", "soft": 2 << 20, "hard": 256 << 20, "effective": 32 << 20, "usage": 10 << 20,
						"override": map[string]any{"value": 32 << 20, "expiresAt": 1756600000, "note": "contest", "requestId": nil, "grantedBy": "m_boss", "grantedByLogin": "boss", "grantedAt": 1756000000}},
					map[string]any{"key": "asset.versionsPerBundle", "unit": "count", "soft": 50, "hard": 500, "effective": 50, "usage": 3, "override": nil},
				},
				"pending": []any{sampleRequest},
			}
		},
		"POST /limit-requests": func(r recorded) (int, any) { return 201, sampleRequest },
	}, nil, nil, []any{limitBundle}))
	out, _, err := run(t, f, "limit", "list", "--bundle", "maps")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_list", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/limits?scope=bundle%3Aab_1" {
		t.Errorf("list path = %s", got)
	}

	if _, _, err := run(t, f, "limit", "request", "asset.fileBytes", "64MiB", "--bundle", "maps"); err == nil || !strings.Contains(err.Error(), "--reason") {
		t.Errorf("request without --reason: %v", err)
	}
	out, _, err = run(t, f, "limit", "request", "asset.fileBytes", "64MiB", "--bundle", "maps", "--reason", "music packs")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_request", out)
	body := f.reqs[len(f.reqs)-1].Body
	if body["scope"] != "bundle:ab_1" || body["key"] != "asset.fileBytes" || body["value"] != float64(64<<20) || body["reason"] != "music packs" {
		t.Errorf("request body = %v", body)
	}
	// A cooldown's end is printed as a time, not a number.
	cool := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /limit-requests": func(recorded) (int, any) {
			return 429, map[string]any{"error": map[string]any{"code": "rate_limited", "message": "recently", "details": map[string]any{"retryAt": 1756600000}}}
		},
	}, nil, nil, []any{limitBundle}))
	if _, _, err := run(t, cool, "limit", "request", "asset.fileBytes", "4MiB", "--bundle", "maps", "--reason", "r"); err == nil || !strings.Contains(err.Error(), "ask again after 2025-08-31T00:26:40Z") {
		t.Errorf("cooldown error = %v", err)
	}
	// No --bundle/--channel: the project in context.
	if _, _, err := run(t, f, "limit", "request", "asset.projectBytes", "1GiB", "--reason", "r"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Body["scope"]; got != "project:prj_1" {
		t.Errorf("project scope = %v", got)
	}
	if _, _, err := run(t, f, "limit", "request", "asset.projectBytes", "1GiB", "--scope", "org", "--reason", "r"); err == nil || !strings.Contains(err.Error(), "want team or project") {
		t.Errorf("bad --scope: %v", err)
	}
	if _, _, err := run(t, f, "limit", "request", "asset.projectBytes", "1GiB", "--scope", "team", "--bundle", "maps", "--reason", "r"); err == nil || !strings.Contains(err.Error(), "pass one of") {
		t.Errorf("scope team with bundle: %v", err)
	}
}

func TestLimitTeamScopeAndSteps(t *testing.T) {
	withProject(t)
	teamRow := func(usage float64, next any) map[string]any {
		return map[string]any{"key": "team.projects", "unit": "count", "soft": 20, "hard": 1000, "effective": 20, "usage": usage, "step": 5, "next": next, "override": nil}
	}
	teamRequest := map[string]any{}
	for k, v := range sampleRequest {
		teamRequest[k] = v
	}
	teamRequest["scope"] = map[string]any{"kind": "team", "id": "team_1", "name": "dooroo"}
	teamRequest["key"], teamRequest["unit"], teamRequest["requestedValue"] = "team.projects", "count", 25
	atLimit := true
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /limits": func(r recorded) (int, any) {
			row := teamRow(12, nil)
			if atLimit {
				row = teamRow(20, 25)
			}
			return 200, map[string]any{"scope": map[string]any{"kind": "team", "id": "team_1"}, "teamId": "team_1", "limits": []any{row}, "pending": []any{}}
		},
		"POST /limit-requests": func(r recorded) (int, any) { return 201, teamRequest },
		"PUT /admin/limit-overrides/team/team_1/team.projects": func(recorded) (int, any) {
			return 200, map[string]any{"key": "team.projects", "unit": "count", "effective": 40}
		},
		"DELETE /admin/limit-overrides/team/team_1/team.projects": func(recorded) (int, any) { return 204, nil },
	}, nil, nil, nil))

	// `--scope team` reads the team's limits; the note says what to ask for.
	out, _, err := run(t, f, "limit", "list", "--scope", "team")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_list_team", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/limits?scope=team%3Ateam_1" {
		t.Errorf("list path = %s", got)
	}
	// A `team.` limit picks the team by itself; `+5` becomes the server's next.
	out, _, err = run(t, f, "limit", "request", "team.projects", "+5", "--team", "dooroo", "--reason", "one per minigame")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_request_team", out)
	body := f.reqs[len(f.reqs)-1].Body
	if body["scope"] != "team:team_1" || body["key"] != "team.projects" || body["value"] != float64(25) || body["reason"] != "one per minigame" {
		t.Errorf("request body = %v", body)
	}
	// Not the step: effective + N, and the server decides.
	if _, _, err := run(t, f, "limit", "request", "team.projects", "+10", "--team", "dooroo", "--reason", "r"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Body["value"]; got != float64(30) {
		t.Errorf("+10 value = %v", got)
	}
	// An absolute value still goes through as typed.
	if _, _, err := run(t, f, "limit", "request", "team.projects", "25", "--team", "dooroo", "--reason", "r"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Body["value"]; got != float64(25) {
		t.Errorf("absolute value = %v", got)
	}
	// Below the limit there is no next: +5 is effective + 5 (the server answers 400).
	atLimit = false
	if _, _, err := run(t, f, "limit", "request", "team.projects", "+5", "--team", "dooroo", "--reason", "r"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Body["value"]; got != float64(25) {
		t.Errorf("below-limit +5 value = %v", got)
	}
	for _, bad := range []string{"+0", "+x", "+-3"} {
		if _, _, err := run(t, f, "limit", "request", "team.projects", bad, "--team", "dooroo", "--reason", "r"); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	// Admin verbs on the team scope.
	if _, _, err := run(t, f, "limit", "set", "team.projects", "40", "--team", "dooroo", "--note", "contest"); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[len(f.reqs)-1].Path; got != "/admin/limit-overrides/team/team_1/team.projects" {
		t.Errorf("set path = %s", got)
	}
	if out, _, err := run(t, f, "limit", "revoke", "team.projects", "--team", "dooroo", "--note", "over"); err != nil || out != "revoked team.projects on team:team_1\n" {
		t.Errorf("revoke = %q, %v", out, err)
	}
}

func TestLimitAdminVerbs(t *testing.T) {
	withProject(t)
	approved := map[string]any{}
	for k, v := range sampleRequest {
		approved[k] = v
	}
	approved["status"], approved["decidedValue"], approved["decidedAt"], approved["decidedByLogin"] = "approved", 32<<20, 1756000100, "boss"
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /admin/limit-requests/lr_01k/approve": func(recorded) (int, any) { return 200, approved },
		"GET /limit-requests/lr_01k":                func(recorded) (int, any) { return 200, approved },
		"POST /admin/limit-requests/lr_01k/reject":  func(recorded) (int, any) { return 200, sampleRequest },
		"POST /limit-requests/lr_01k/cancel":        func(recorded) (int, any) { return 200, sampleRequest },
		"GET /admin/limit-requests": func(recorded) (int, any) {
			return 200, map[string]any{"requests": []any{sampleRequest}, "next": "lr_01k", "pending": 4, "oldestPendingAt": 1756000000}
		},
		"PUT /admin/limit-overrides/channel/auth_0123/channel.lifetime": func(recorded) (int, any) {
			return 200, map[string]any{"key": "channel.lifetime", "unit": "seconds", "effective": "unlimited",
				"override": map[string]any{"value": "unlimited", "expiresAt": nil, "note": "demo", "requestId": nil, "grantedBy": "m_boss", "grantedAt": 1}}
		},
		"PUT /admin/limit-overrides/bundle/ab_1/asset.bundleBytes": func(recorded) (int, any) {
			return 200, map[string]any{"key": "asset.bundleBytes", "unit": "bytes", "effective": 1 << 30}
		},
		"DELETE /admin/limit-overrides/bundle/ab_1/asset.bundleBytes": func(recorded) (int, any) { return 204, nil },
	}, []any{sampleChannel}, nil, []any{limitBundle}))

	out, _, err := run(t, f, "limit", "approve", "lr_01k", "--value", "32MiB", "--note", "plenty")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_approve", out)
	if b := f.reqs[len(f.reqs)-1].Body; b["value"] != float64(32<<20) || b["note"] != "plenty" {
		t.Errorf("approve body = %v", b)
	}
	if out, _, err := run(t, f, "limit", "get", "lr_01k"); err != nil || !strings.Contains(out, "granted:   32 MiB") {
		t.Errorf("get = %q, %v", out, err)
	}
	if _, _, err := run(t, f, "limit", "reject", "lr_01k"); err == nil {
		t.Error("reject without --note accepted")
	}
	if _, _, err := run(t, f, "limit", "reject", "lr_01k", "--note", "use a CDN"); err != nil {
		t.Fatal(err)
	}
	if b := f.reqs[len(f.reqs)-1].Body; b["note"] != "use a CDN" {
		t.Errorf("reject body = %v", b)
	}
	if _, _, err := run(t, f, "limit", "cancel", "lr_01k"); err != nil {
		t.Fatal(err)
	}
	out, errOut, err := run(t, f, "limit", "requests", "--all", "--status", "pending")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "limit_requests", out)
	if !strings.Contains(errOut, "pending across every team: 4") || !strings.Contains(errOut, "more: --cursor lr_01k") {
		t.Errorf("requests stderr = %q", errOut)
	}
	if got := f.reqs[len(f.reqs)-1].Path; got != "/admin/limit-requests?status=pending" {
		t.Errorf("requests path = %s", got)
	}

	if _, _, err := run(t, f, "limit", "set", "channel.lifetime", "unlimited", "--channel", "auth_0123", "--note", "demo"); err != nil {
		t.Fatal(err)
	}
	if b := f.reqs[len(f.reqs)-1].Body; b["value"] != "unlimited" || b["note"] != "demo" || b["expiresAt"] != nil {
		t.Errorf("set body = %v", b)
	}
	before := time.Now().Unix()
	if _, _, err := run(t, f, "limit", "set", "asset.bundleBytes", "1GiB", "--bundle", "maps", "--expires", "7d", "--note", "contest"); err != nil {
		t.Fatal(err)
	}
	exp, _ := f.reqs[len(f.reqs)-1].Body["expiresAt"].(float64)
	if int64(exp) < before+7*86400 || int64(exp) > time.Now().Unix()+7*86400 {
		t.Errorf("expiresAt = %v", exp)
	}
	if _, _, err := run(t, f, "limit", "revoke", "asset.bundleBytes", "--bundle", "maps"); err == nil {
		t.Error("revoke without --note accepted")
	}
	out, _, err = run(t, f, "limit", "revoke", "asset.bundleBytes", "--bundle", "maps", "--note", "over")
	if err != nil || out != "revoked asset.bundleBytes on bundle:ab_1\n" {
		t.Errorf("revoke = %q, %v", out, err)
	}
	if b := f.reqs[len(f.reqs)-1]; b.Method != "DELETE" || b.Body["note"] != "over" {
		t.Errorf("revoke request = %+v", b)
	}
	if _, _, err := run(t, f, "limit", "list", "--bundle", "maps", "--channel", "auth_0123"); err == nil {
		t.Error("both scopes accepted")
	}
}

func TestChannelNoExpiryPrints(t *testing.T) {
	withProject(t)
	ch := map[string]any{}
	for k, v := range sampleChannel {
		ch[k] = v
	}
	ch["expiresAt"] = channelNoExpirySec
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/auth_0123": func(recorded) (int, any) { return 200, ch },
	}, []any{ch}, nil, nil))
	out, _, err := run(t, f, "channels", "get", "auth_0123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "expires:") || !strings.Contains(out, "no expiry") {
		t.Errorf("get = %s", out)
	}
}

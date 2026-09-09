package cmd

import (
	"strings"
	"testing"
)

const lbID = "lb_01j5abcdefghjkmnpqrstvwxyz"

var sampleLb = map[string]any{
	"id": lbID, "name": "highscores", "submit": "owner", "rule": "best", "order": "desc",
	"periods": []any{"alltime", "daily"}, "maxEntries": 2000, "retainPeriods": 4,
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

func sampleLbDetail() map[string]any {
	d := map[string]any{}
	for k, v := range sampleLb {
		d[k] = v
	}
	d["description"] = "the ladder"
	d["period"] = "alltime"
	d["periodKey"] = ""
	d["scores"] = 2
	d["api"] = map[string]any{
		"configured": true, "baseUrl": "https://doc-dev.yyt.life",
		"metaPath": "/lb/" + lbID, "namePath": "/lb/highscores",
		"topPath": "/lb/" + lbID + "/top", "scorePath": "/lb/" + lbID + "/scores/{ownerId}",
	}
	return d
}

func lbScoreRow(owner string, rank int, score int, meta any) map[string]any {
	s := map[string]any{
		"rank": rank, "owner": owner, "score": score, "meta": meta,
		"channelId": "auth_1", "updatedAt": 1756000200,
	}
	return s
}

func TestLbListGetAndCreate(t *testing.T) {
	withProject(t)
	var created map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1/leaderboards": func(recorded) (int, any) {
			return 200, map[string]any{"leaderboards": []any{sampleLb}}
		},
		"GET /leaderboards/" + lbID: func(recorded) (int, any) { return 200, sampleLbDetail() },
		"POST /projects/prj_1/leaderboards": func(r recorded) (int, any) {
			created = r.Body
			return 201, sampleLbDetail()
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "lb", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "lb_list", out)
	// A name resolves through the project's list; the detail is then by id.
	out, _, err = run(t, f, "lb", "get", "HighScores")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "lb_get", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/leaderboards/"+lbID {
		t.Fatalf("detail path %s", got)
	}

	// Every enum the console would refuse is refused here, before any request.
	n := len(f.reqs)
	for _, args := range [][]string{
		{"lb", "create", "x", "--submit", "anyone"},
		{"lb", "create", "x", "--submit", "owner", "--rule", "biggest"},
		{"lb", "create", "x", "--submit", "owner", "--order", "up"},
		{"lb", "create", "x", "--submit", "owner", "--periods", "monthly"},
		{"lb", "create", "x", "--submit", "owner", "--periods", "daily,daily"},
		{"lb", "create", "x", "--submit", "owner", "--periods", ""},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatalf("a request was made for a bad flag")
	}

	out, _, err = run(t, f, "lb", "create", "highscores",
		"--submit", "owner", "--order", "asc",
		// Named out of order: the body carries the canonical one, because the
		// first period is the bucket every read defaults to.
		"--periods", "weekly,alltime", "--retain-periods", "2", "--description", "the ladder")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"name": "highscores", "submit": "owner", "rule": "best", "order": "asc",
		"retainPeriods": float64(2), "description": "the ladder",
	}
	if len(created) != len(want)+1 {
		t.Fatalf("create body %v", created)
	}
	for k, v := range want {
		if created[k] != v {
			t.Fatalf("create body[%s] = %v, want %v", k, created[k], v)
		}
	}
	periods, _ := created["periods"].([]any)
	if len(periods) != 2 || periods[0] != "alltime" || periods[1] != "weekly" {
		t.Fatalf("create body periods %v", created["periods"])
	}
	if !strings.Contains(out, "apiScore") {
		t.Fatalf("create output lacks the api block:\n%s", out)
	}
}

func TestLbUpdateSendsOnlyTheGivenFields(t *testing.T) {
	withProject(t)
	var patched map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /leaderboards/" + lbID: func(r recorded) (int, any) {
			patched = r.Body
			return 200, sampleLbDetail()
		},
	}, nil, nil, nil))
	// Nothing to do costs no request.
	n := len(f.reqs)
	if _, _, err := run(t, f, "lb", "update", lbID); err == nil {
		t.Fatal("an empty update was accepted")
	}
	if len(f.reqs) != n {
		t.Fatal("an empty update made a request")
	}
	if _, _, err := run(t, f, "lb", "update", lbID, "--retain-periods", "0"); err != nil {
		t.Fatal(err)
	}
	// `0` is a real value here — a board keeping only its live bucket — so the
	// flag's presence, not its value, is what puts it in the body.
	if len(patched) != 1 || patched["retainPeriods"] != float64(0) {
		t.Fatalf("patch body %v", patched)
	}
	if _, _, err := run(t, f, "lb", "update", lbID, "--description", ""); err != nil {
		t.Fatal(err)
	}
	if len(patched) != 1 || patched["description"] != nil {
		t.Fatalf("an empty --description must clear it: %v", patched)
	}
}

func TestLbTopAndScore(t *testing.T) {
	withProject(t)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /leaderboards/" + lbID + "/scores": func(recorded) (int, any) {
			return 200, map[string]any{
				"period": "alltime", "periodKey": "", "total": 3,
				"scores": []any{
					lbScoreRow("aaaa", 1, 250, `{"name":"a"}`),
					lbScoreRow("bbbb", 1, 250, nil),
					lbScoreRow("cccc", 3, 10, nil),
				},
			}
		},
		"GET /leaderboards/" + lbID + "/scores/aaaa": func(recorded) (int, any) {
			return 200, map[string]any{
				"period": "daily", "periodKey": "2026-09-10", "total": 3,
				"rank": 1, "owner": "aaaa", "score": 250, "meta": `{"name":"a"}`,
				"channelId": "auth_1", "updatedAt": 1756000200,
			}
		},
	}, nil, nil, nil))
	out, errOut, err := run(t, f, "lb", "top", lbID, "--period", "alltime", "--limit", "10")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "lb_top", out)
	// Which bucket answered goes to stderr, so a piped table stays a table.
	if !strings.Contains(errOut, "bucket alltime, 3 score(s)") {
		t.Fatalf("stderr %q", errOut)
	}
	if got := f.reqs[len(f.reqs)-1].Path; got != "/leaderboards/"+lbID+"/scores?limit=10&period=alltime" {
		t.Fatalf("top path %s", got)
	}
	out, _, err = run(t, f, "lb", "score", "get", lbID, "aaaa", "--period", "daily")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "lb_score_get", out)
	if got := f.reqs[len(f.reqs)-1].Path; got != "/leaderboards/"+lbID+"/scores/aaaa?period=daily" {
		t.Fatalf("score path %s", got)
	}
}

func TestLbScoreHasNoPut(t *testing.T) {
	withProject(t)
	f := newFake(t, ctxRoutes(nil, nil, nil, nil))
	// The console never writes a score, so the CLI offers no verb that would
	// (`docs/decisions.md` *Serverless clients* #2).
	n := len(f.reqs)
	for _, args := range [][]string{
		{"lb", "score", "put", lbID, "aaaa", "10"},
		{"lb", "score", "set", lbID, "aaaa", "10"},
		{"lb", "submit", lbID, "aaaa", "10"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatal("a write verb reached the console")
	}
}

func TestLbScoreDeleteAndClear(t *testing.T) {
	withProject(t)
	calls := 0
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"DELETE /leaderboards/" + lbID + "/scores/aaaa": func(recorded) (int, any) {
			return 200, map[string]any{"deleted": 2}
		},
		"DELETE /leaderboards/" + lbID + "/periods/alltime": func(recorded) (int, any) {
			calls++
			// Truncated once, so the loop has to come back: the console drains
			// in bounded batches.
			if calls == 1 {
				return 200, map[string]any{"deleted": 1000, "truncated": true}
			}
			return 200, map[string]any{"deleted": 7, "truncated": false}
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "lb", "score", "delete", lbID, "aaaa")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "deleted 2 row(s) of aaaa across every period") {
		t.Fatalf("delete output %q", out)
	}
	out, _, err = run(t, f, "lb", "clear", lbID, "alltime")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("clear stopped after %d call(s)", calls)
	}
	if !strings.Contains(out, "deleted 1007 score(s) in alltime") {
		t.Fatalf("clear output %q", out)
	}
}

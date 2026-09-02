package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTeamListGetCreateJoin(t *testing.T) {
	var created, joined map[string]any
	detail := map[string]any{}
	for k, v := range sampleTeam {
		detail[k] = v
	}
	detail["counts"] = map[string]any{"owners": 1, "members": 2, "pending": 1, "projects": 3}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams": func(r recorded) (int, any) {
			pending := map[string]any{"id": "team_9", "name": "waiting", "role": "pending"}
			return 200, map[string]any{"teams": []any{sampleTeam, pending}}
		},
		"GET /teams/team_1": func(recorded) (int, any) { return 200, detail },
		"GET /teams/team_9": func(recorded) (int, any) {
			return 200, map[string]any{"id": "team_9", "name": "waiting", "role": "pending"}
		},
		"POST /teams": func(r recorded) (int, any) {
			created = r.Body
			return 201, sampleTeam
		},
		"POST /teams/join": func(r recorded) (int, any) {
			joined = r.Body
			return 202, map[string]any{"id": "team_9", "name": "waiting", "role": "pending"}
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "team", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "team_list", out)
	// `get` with no argument uses the context; the only seated team is
	// auto-selected (the pending one does not count).
	out, _, err = run(t, f, "team", "get")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "team_get", out)
	// A pending team is readable by name (the server serves its name view).
	if _, _, err := run(t, f, "team", "get", "waiting"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "team", "update", "waiting", "--name", "x"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("a pending seat must not be a write context: %v", err)
	}
	if _, _, err := run(t, f, "team", "create", "dooroo", "--description", "the studio"); err != nil {
		t.Fatal(err)
	}
	if created["name"] != "dooroo" || created["description"] != "the studio" {
		t.Fatalf("create body %v", created)
	}
	out, errs, err := run(t, f, "team", "join", "waiting")
	if err != nil || joined["name"] != "waiting" {
		t.Fatalf("%v %v", err, joined)
	}
	if !strings.Contains(out, "role:") || !strings.Contains(out, "pending") || !strings.Contains(errs, "approves") {
		t.Fatalf("out=%q errs=%q", out, errs)
	}
	// A pending view must not print fields it does not have.
	if strings.Contains(out, "adminLocked") {
		t.Fatalf("pending view leaked detail fields:\n%s", out)
	}
}

func TestTeamUpdateDeleteLockNeedExplicitContext(t *testing.T) {
	var patched, locked map[string]any
	deleted := false
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /teams/team_1":          func(r recorded) (int, any) { patched = r.Body; return 200, sampleTeam },
		"DELETE /teams/team_1":         func(recorded) (int, any) { deleted = true; return 204, nil },
		"PUT /teams/team_1/admin-lock": func(r recorded) (int, any) { locked = r.Body; return 200, sampleTeam },
	}, nil, nil, nil))
	// Writes never auto-select, even with a single team.
	for _, args := range [][]string{
		{"team", "update", "--name", "x"},
		{"team", "delete"},
		{"team", "admin-lock", "--locked=true"},
	} {
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), "no team context") {
			t.Errorf("%v: err=%v", args, err)
		}
	}
	// The positional team is an explicit context.
	if _, _, err := run(t, f, "team", "update", "dooroo", "--description", ""); err != nil {
		t.Fatal(err)
	}
	if v, ok := patched["description"]; !ok || v != nil {
		t.Fatalf("empty --description must send null: %v", patched)
	}
	if _, _, err := run(t, f, "team", "update", "dooroo"); err == nil {
		t.Fatal("nothing to update must fail")
	}
	if _, _, err := run(t, f, "team", "admin-lock", "team_1", "--locked=false"); err != nil || locked["locked"] != false {
		t.Fatalf("%v %v", err, locked)
	}
	if _, _, err := run(t, f, "team", "admin-lock", "team_1"); err == nil {
		t.Fatal("--locked is required")
	}
	t.Setenv("YYT_TEAM", "dooroo")
	out, _, err := run(t, f, "team", "rm")
	if err != nil || !deleted || out != "deleted dooroo\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestTeamMembers(t *testing.T) {
	var added, roleSet map[string]any
	var removedPath string
	rotate := map[string]any{"removed": "m_2", "action": "kick", "rotate": []any{
		map[string]any{"id": "auth_0123", "kind": "auth", "name": "demo"},
	}}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /me": func(recorded) (int, any) {
			return 200, map[string]any{"id": "m_1", "login": "octo", "role": "member", "via": "token"}
		},
		"GET /teams/team_1/members": func(recorded) (int, any) {
			return 200, map[string]any{"members": []any{
				map[string]any{"id": "m_1", "login": "octo", "platformRole": "admin", "role": "owner", "state": "active",
					"requestedAt": 1756000000, "decidedAt": 1756000000, "decidedBy": nil},
				map[string]any{"id": "m_2", "login": "newbie", "platformRole": "member", "role": "pending", "state": "active",
					"requestedAt": 1756001000, "decidedAt": nil, "decidedBy": nil},
			}}
		},
		"POST /teams/team_1/members": func(r recorded) (int, any) {
			added = r.Body
			return 201, map[string]any{"id": "m_3", "login": "friend", "role": r.Body["role"], "state": "active", "requestedAt": 1}
		},
		"PATCH /teams/team_1/members/m_2": func(r recorded) (int, any) {
			roleSet = r.Body
			return 200, map[string]any{"id": "m_2", "login": "newbie", "role": r.Body["role"], "state": "active", "requestedAt": 1}
		},
		"DELETE /teams/team_1/members/m_2": func(r recorded) (int, any) { removedPath = r.Path; return 200, rotate },
		"DELETE /teams/team_1/members/m_1": func(r recorded) (int, any) { removedPath = r.Path; return 204, nil },
	}, nil, nil, nil))
	out, _, err := run(t, f, "team", "members", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "team_members_list", out)

	t.Setenv("YYT_TEAM", "team_1")
	if _, _, err := run(t, f, "team", "members", "add", "friend", "--role", "owner"); err != nil || added["login"] != "friend" || added["role"] != "owner" {
		t.Fatalf("%v %v", err, added)
	}
	if _, _, err := run(t, f, "team", "members", "add", "friend", "--role", "boss"); err == nil {
		t.Fatal("bad role must fail")
	}
	for _, c := range []struct{ cmd, role string }{{"approve", "member"}, {"promote", "owner"}, {"demote", "member"}} {
		if _, _, err := run(t, f, "team", "members", c.cmd, "m_2"); err != nil || roleSet["role"] != c.role {
			t.Fatalf("%s: %v %v", c.cmd, err, roleSet)
		}
	}
	// kick prints the rotation nudge on stderr, never silently.
	out, errs, err := run(t, f, "team", "members", "kick", "m_2")
	if err != nil || out != "kick m_2\n" || !strings.Contains(errs, "rotate") || !strings.Contains(errs, "auth_0123") {
		t.Fatalf("%v out=%q errs=%q", err, out, errs)
	}
	// leave resolves the caller's own id through /me; a 204 is a withdrawn request.
	out, _, err = run(t, f, "team", "members", "leave")
	if err != nil || removedPath != "/teams/team_1/members/m_1" || out != "declined m_1\n" {
		t.Fatalf("%v %s %q", err, removedPath, out)
	}
}

func TestTeamDiscussionsAndComments(t *testing.T) {
	var body map[string]any
	disc := map[string]any{"id": "dsc_1", "teamId": "team_1", "title": "Hello", "bodyMd": "# hi\n\ntext", "createdBy": "octo",
		"createdAt": 1756000000, "updatedAt": 1756000100, "mine": true}
	detail := map[string]any{}
	for k, v := range disc {
		detail[k] = v
	}
	detail["comments"] = []any{map[string]any{"id": "cmt_1", "bodyMd": "nice", "createdBy": "newbie", "createdAt": 1756000200, "updatedAt": 1756000200, "mine": false}}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams/team_1/discussions":          func(recorded) (int, any) { return 200, map[string]any{"discussions": []any{disc}} },
		"POST /teams/team_1/discussions":         func(r recorded) (int, any) { body = r.Body; return 201, disc },
		"GET /teams/team_1/discussions/dsc_1":    func(recorded) (int, any) { return 200, detail },
		"PATCH /teams/team_1/discussions/dsc_1":  func(r recorded) (int, any) { body = r.Body; return 200, disc },
		"DELETE /teams/team_1/discussions/dsc_1": func(recorded) (int, any) { return 204, nil },
		"POST /teams/team_1/discussions/dsc_1/comments": func(r recorded) (int, any) {
			body = r.Body
			return 201, map[string]any{"id": "cmt_2", "bodyMd": r.Body["bodyMd"], "createdBy": "octo", "createdAt": 1, "updatedAt": 1, "mine": true}
		},
		"PATCH /teams/team_1/discussions/dsc_1/comments/cmt_2": func(r recorded) (int, any) {
			body = r.Body
			return 200, map[string]any{"id": "cmt_2", "bodyMd": r.Body["bodyMd"], "createdBy": "octo", "createdAt": 1, "updatedAt": 2, "mine": true}
		},
		"DELETE /teams/team_1/discussions/dsc_1/comments/cmt_2": func(recorded) (int, any) { return 204, nil },
	}, nil, nil, nil))
	out, _, err := run(t, f, "team", "discussion", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "team_discussion_list", out)
	out, _, err = run(t, f, "team", "discussion", "get", "dsc_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "team_discussion_get", out)

	t.Setenv("YYT_TEAM", "dooroo")
	md := filepath.Join(t.TempDir(), "post.md")
	_ = os.WriteFile(md, []byte("# from file\n"), 0o644)
	if _, _, err := run(t, f, "team", "discussion", "create", "Hello", "--body", "@"+md); err != nil || body["bodyMd"] != "# from file\n" || body["title"] != "Hello" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "team", "discussion", "create", "Hello"); err == nil {
		t.Fatal("--body is required")
	}
	if _, _, err := run(t, f, "team", "discussion", "update", "dsc_1", "--title", "Hi"); err != nil || body["title"] != "Hi" || body["bodyMd"] != nil {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "team", "discussion", "comment", "add", "dsc_1", "--body", "+1"); err != nil || body["bodyMd"] != "+1" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "team", "discussion", "comment", "update", "dsc_1", "cmt_2", "--body", "+2"); err != nil || body["bodyMd"] != "+2" {
		t.Fatalf("%v %v", err, body)
	}
	if out, _, err := run(t, f, "team", "discussion", "comment", "rm", "dsc_1", "cmt_2"); err != nil || out != "deleted cmt_2\n" {
		t.Fatalf("%v %q", err, out)
	}
	if out, _, err := run(t, f, "team", "discussion", "rm", "dsc_1"); err != nil || out != "deleted dsc_1\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestTeamHistoryPaging(t *testing.T) {
	var path string
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams/team_1/history": func(r recorded) (int, any) {
			path = r.Path
			return 200, map[string]any{"history": []any{
				map[string]any{"id": "h1", "at": 1756000000, "actor": "octo", "action": "member.kick", "subject": "newbie", "target": nil, "detail": nil},
				map[string]any{"id": "h2", "at": 1756000100, "actor": nil, "action": "resource.expire", "subject": nil, "target": "auth_0123", "detail": map[string]any{"kind": "auth"}},
			}, "next": "h2"}
		},
	}, nil, nil, nil))
	out, errs, err := run(t, f, "team", "history", "--limit", "2", "--cursor", "h0")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/teams/team_1/history?cursor=h0&limit=2" {
		t.Fatalf("path %s", path)
	}
	if !strings.Contains(errs, "--cursor h2") {
		t.Fatalf("next cursor hint missing: %q", errs)
	}
	golden(t, "team_history", out)
}

func TestCommentBodyFileAndRequired(t *testing.T) {
	var body map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /teams/team_1/discussions/dsc_1/comments": func(r recorded) (int, any) {
			body = r.Body
			return 201, map[string]any{"id": "cmt_2", "bodyMd": r.Body["bodyMd"], "createdBy": "octo", "createdAt": 1, "updatedAt": 1, "mine": true}
		},
		"PATCH /projects/prj_1/issues/1/comments/cmt_2": func(r recorded) (int, any) {
			body = r.Body
			return 200, map[string]any{"id": "cmt_2", "bodyMd": r.Body["bodyMd"], "createdBy": "octo", "createdAt": 1, "updatedAt": 2, "mine": true}
		},
	}, nil, nil, nil))
	t.Setenv("YYT_TEAM", "dooroo")
	withProject(t)
	md := filepath.Join(t.TempDir(), "c.md")
	_ = os.WriteFile(md, []byte("from file\n"), 0o644)
	if _, _, err := run(t, f, "team", "discussion", "comment", "add", "dsc_1", "--body", "@"+md); err != nil || body["bodyMd"] != "from file\n" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "issue", "comment", "update", "1", "cmt_2", "--body", "@"+md); err != nil || body["bodyMd"] != "from file\n" {
		t.Fatalf("%v %v", err, body)
	}
	n := len(f.reqs)
	for _, args := range [][]string{
		{"team", "discussion", "comment", "add", "dsc_1"},
		{"project", "issue", "comment", "update", "1", "cmt_2"},
		{"team", "discussion", "comment", "add", "dsc_1", "--body", "@" + filepath.Join(t.TempDir(), "missing.md")},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Errorf("expected error for %v", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatal("validation must not hit the API")
	}
}

package cmd

import (
	"strings"
	"testing"
)

func TestProjectListGetCreateUpdateDelete(t *testing.T) {
	var body map[string]any
	detail := map[string]any{}
	for k, v := range sampleProject {
		detail[k] = v
	}
	detail["counts"] = map[string]any{"channels": 3, "apps": 1, "bundles": 2, "versions": 4, "issues": 5}
	deleted := false
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1":         func(recorded) (int, any) { return 200, detail },
		"POST /teams/team_1/projects": func(r recorded) (int, any) { body = r.Body; return 201, sampleProject },
		"PATCH /projects/prj_1":       func(r recorded) (int, any) { body = r.Body; return 200, sampleProject },
		"DELETE /projects/prj_1":      func(recorded) (int, any) { deleted = true; return 204, nil },
	}, nil, nil, nil))
	out, _, err := run(t, f, "project", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_list", out)
	// `get` auto-selects the only project of the only team; a name and an id
	// give the same view.
	out, _, err = run(t, f, "project", "get")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_get", out)
	for _, arg := range []string{"game", "GAME", "prj_1"} {
		out2, _, err := run(t, f, "project", "get", arg)
		if err != nil || out2 != out {
			t.Fatalf("%s: %v\n%s", arg, err, out2)
		}
	}
	if _, _, err := run(t, f, "project", "get", "nope"); err == nil || !strings.Contains(err.Error(), `project "nope" not found`) {
		t.Fatalf("err=%v", err)
	}

	// create needs an explicit team; update/delete an explicit project.
	if _, _, err := run(t, f, "project", "create", "game"); err == nil || !strings.Contains(err.Error(), "no team context") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "project", "create", "game", "--team", "dooroo", "--description", "d"); err != nil || body["name"] != "game" || body["description"] != "d" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "update", "--name", "x"); err == nil || !strings.Contains(err.Error(), "no team context") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "project", "update", "game", "--team", "dooroo", "--name", "x", "--description", ""); err != nil {
		t.Fatal(err)
	}
	if v, ok := body["description"]; body["name"] != "x" || !ok || v != nil {
		t.Fatalf("patch %v", body)
	}
	withProject(t)
	if out, _, err := run(t, f, "project", "rm"); err != nil || !deleted || out != "deleted game\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestProjectVersions(t *testing.T) {
	var body map[string]any
	var lastPath string
	v1 := map[string]any{"id": "ver_1", "projectId": "prj_1", "name": "1.0.0", "note": "first", "createdBy": "octo", "createdAt": 1756000000, "artifactCount": 1, "assetCount": 1}
	v2 := map[string]any{"id": "ver_2", "projectId": "prj_1", "name": "1.0.1", "note": nil, "createdBy": "octo", "createdAt": 1756000100, "artifactCount": 0, "assetCount": 0}
	detail := map[string]any{}
	for k, v := range v1 {
		detail[k] = v
	}
	detail["links"] = []any{
		map[string]any{"id": "lnk_1", "versionId": "ver_1", "kind": "artifact", "artifactId": "art_1", "bundleId": nil, "assetVersion": nil, "createdAt": 1756000200},
		map[string]any{"id": "lnk_2", "versionId": "ver_1", "kind": "asset_version", "artifactId": nil, "bundleId": "ab_1", "assetVersion": "v3", "createdAt": 1756000300},
	}
	record := func(status int, resp any) func(recorded) (int, any) {
		return func(r recorded) (int, any) { body, lastPath = r.Body, r.Path; return status, resp }
	}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1/versions":                      func(recorded) (int, any) { return 200, map[string]any{"versions": []any{v2, v1}} },
		"POST /projects/prj_1/versions":                     record(201, v1),
		"POST /projects/prj_1/versions/bump":                record(201, v2),
		"GET /projects/prj_1/versions/ver_1":                func(recorded) (int, any) { return 200, detail },
		"PATCH /projects/prj_1/versions/ver_1":              record(200, v1),
		"DELETE /projects/prj_1/versions/ver_1":             record(204, nil),
		"POST /projects/prj_1/versions/ver_1/links":         record(201, map[string]any{"id": "lnk_3", "versionId": "ver_1", "kind": "asset_version", "createdAt": 1}),
		"DELETE /projects/prj_1/versions/ver_1/links/lnk_3": record(204, nil),
	}, nil, nil, []any{sampleBundle}))
	out, _, err := run(t, f, "project", "version", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_version_list", out)
	// A version is addressed by its exact name or its id.
	out, _, err = run(t, f, "project", "version", "get", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_version_get", out)
	if _, _, err := run(t, f, "project", "version", "get", "1.0"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err=%v", err)
	}

	withProject(t)
	if _, _, err := run(t, f, "project", "version", "create", "1.0.0", "--note", "first"); err != nil || body["name"] != "1.0.0" || body["note"] != "first" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "version", "bump", "minor"); err != nil || body["part"] != "minor" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "version", "bump", "huge"); err == nil {
		t.Fatal("bad part must fail")
	}
	if _, _, err := run(t, f, "project", "version", "update", "ver_1", "--note", ""); err != nil {
		t.Fatal(err)
	}
	if v, ok := body["note"]; !ok || v != nil {
		t.Fatalf("empty note must send null: %v", body)
	}
	// Links: an artifact by id, or a bundle (by name, resolved) + asset version.
	if _, _, err := run(t, f, "project", "version", "link", "1.0.0", "--artifact", "art_1"); err != nil || body["kind"] != "artifact" || body["artifactId"] != "art_1" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "version", "link", "1.0.0", "--bundle", "dungeon-maps", "--asset-version", "v3"); err != nil ||
		body["kind"] != "asset_version" || body["bundleId"] != "ab_1" || body["assetVersion"] != "v3" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "version", "link", "1.0.0", "--bundle", "ab_1"); err == nil {
		t.Fatal("bundle without asset version must fail")
	}
	if out, _, err := run(t, f, "project", "version", "unlink", "ver_1", "lnk_3"); err != nil || out != "unlinked lnk_3\n" || lastPath != "/projects/prj_1/versions/ver_1/links/lnk_3" {
		t.Fatalf("%v %q %s", err, out, lastPath)
	}
	if out, _, err := run(t, f, "project", "version", "rm", "1.0.0"); err != nil || out != "deleted 1.0.0\n" {
		t.Fatalf("%v %q", err, out)
	}
}

func TestProjectIssues(t *testing.T) {
	var body map[string]any
	var lastPath string
	open := map[string]any{"id": "iss_1", "projectId": "prj_1", "number": 1, "title": "Crash on start", "bodyMd": "steps…", "status": "open",
		"versionId": "ver_1", "createdBy": "octo", "createdAt": 1756000000, "updatedAt": 1756000100, "closedAt": nil}
	closed := map[string]any{}
	for k, v := range open {
		closed[k] = v
	}
	closed["status"], closed["closedAt"], closed["number"], closed["title"] = "closed", 1756000500, 2, "Typo"
	detail := map[string]any{}
	for k, v := range open {
		detail[k] = v
	}
	detail["comments"] = []any{map[string]any{"id": "cmt_1", "bodyMd": "me too", "createdBy": "newbie", "createdAt": 1756000200, "updatedAt": 1756000200, "mine": false}}
	record := func(status int, resp any) func(recorded) (int, any) {
		return func(r recorded) (int, any) { body, lastPath = r.Body, r.Path; return status, resp }
	}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /projects/prj_1/issues": func(r recorded) (int, any) {
			lastPath = r.Path
			if strings.Contains(r.Path, "status=closed") {
				return 200, map[string]any{"issues": []any{closed}}
			}
			return 200, map[string]any{"issues": []any{open}}
		},
		"GET /projects/prj_1/versions": func(recorded) (int, any) {
			return 200, map[string]any{"versions": []any{map[string]any{"id": "ver_1", "name": "1.0.0"}}}
		},
		"POST /projects/prj_1/issues":                    record(201, open),
		"GET /projects/prj_1/issues/1":                   func(recorded) (int, any) { return 200, detail },
		"PATCH /projects/prj_1/issues/1":                 record(200, open),
		"POST /projects/prj_1/issues/1/close":            record(200, closed),
		"POST /projects/prj_1/issues/1/reopen":           record(200, open),
		"POST /projects/prj_1/issues/1/comments":         record(201, map[string]any{"id": "cmt_2", "bodyMd": "fixed", "createdBy": "octo", "createdAt": 1, "updatedAt": 1, "mine": true}),
		"DELETE /projects/prj_1/issues/1/comments/cmt_2": record(204, nil),
	}, nil, nil, nil))
	out, _, err := run(t, f, "project", "issue", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_issue_list", out)
	if _, _, err := run(t, f, "project", "issue", "ls", "--status", "closed"); err != nil || lastPath != "/projects/prj_1/issues?status=closed" {
		t.Fatalf("%v %s", err, lastPath)
	}
	out, _, err = run(t, f, "project", "issue", "get", "1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "project_issue_get", out)
	if _, _, err := run(t, f, "project", "issue", "get", "one"); err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("err=%v", err)
	}

	withProject(t)
	// --version takes a version name and sends its id.
	if _, _, err := run(t, f, "project", "issue", "create", "Crash on start", "--body", "steps…", "--version", "1.0.0"); err != nil ||
		body["title"] != "Crash on start" || body["bodyMd"] != "steps…" || body["versionId"] != "ver_1" {
		t.Fatalf("%v %v", err, body)
	}
	if _, _, err := run(t, f, "project", "issue", "update", "1", "--no-version"); err != nil {
		t.Fatal(err)
	}
	if v, ok := body["versionId"]; !ok || v != nil {
		t.Fatalf("--no-version must send null: %v", body)
	}
	if _, _, err := run(t, f, "project", "issue", "update", "1"); err == nil {
		t.Fatal("nothing to update must fail")
	}
	if out, _, err := run(t, f, "project", "issue", "close", "1"); err != nil || !strings.Contains(out, "status:  closed") {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, _, err := run(t, f, "project", "issue", "reopen", "1"); err != nil || lastPath != "/projects/prj_1/issues/1/reopen" {
		t.Fatalf("%v %s", err, lastPath)
	}
	if _, _, err := run(t, f, "project", "issue", "comment", "add", "1", "--body", "fixed"); err != nil || body["bodyMd"] != "fixed" {
		t.Fatalf("%v %v", err, body)
	}
	if out, _, err := run(t, f, "project", "issue", "comment", "rm", "1", "cmt_2"); err != nil || out != "deleted cmt_2\n" {
		t.Fatalf("%v %q", err, out)
	}
}

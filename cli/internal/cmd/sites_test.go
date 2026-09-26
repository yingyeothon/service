package cmd

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/api"
)

var sampleSite = map[string]any{
	"id": "st_1", "name": "game-web", "slug": "k3x9q2mzp", "description": "browser client",
	"teamId": "team_1", "teamName": "dooroo", "projectId": "prj_1", "projectName": "game", "createdBy": "octo",
	"publicUrl": "https://dev-g.yyt.life/k3x9q2mzp/", "basePath": "/k3x9q2mzp/",
	// Unnamed: the path URL stays the primary link although the host exists.
	"domain": nil, "hostUrl": "https://k3x9q2mzp.dev-g.yyt.life/", "hostSuffix": "dev-g.yyt.life", "movingTo": nil,
	"currentDeployId": "sd_01j5", "busy": false,
	"createdAt": 1756000000, "updatedAt": 1756000100,
}

// siteWith is sampleSite with some fields replaced.
func siteWith(kv map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range sampleSite {
		out[k] = v
	}
	for k, v := range kv {
		out[k] = v
	}
	return out
}

// namedSite is sampleSite after it claimed `my-game`.
var namedSite = siteWith(map[string]any{
	"id": "st_2", "name": "named-web", "slug": "my-game", "domain": "my-game",
	"publicUrl": "https://dev-g.yyt.life/my-game/", "basePath": "/my-game/",
	"hostUrl": "https://my-game.dev-g.yyt.life/",
})

// movingSite is mid-move; emptySite has never been deployed.
var (
	movingSite = siteWith(map[string]any{"id": "st_3", "name": "moving-web", "busy": true, "movingTo": "new-name"})
	emptySite  = siteWith(map[string]any{"id": "st_4", "name": "empty-web", "currentDeployId": nil})
)

func sampleMove(id, status, to string) map[string]any {
	d := sampleDeploy(id, status, 12)
	d["kind"], d["moveTo"], d["moveFrom"], d["zipBytes"], d["bytes"] = "move", to, "k3x9q2mzp", 0, 0
	if status == "failed" {
		d["error"] = "copy_failed"
	}
	return d
}

func sampleDeploy(id, status string, files int) map[string]any {
	var errVal any
	if status == "failed" {
		errVal = "zip_no_index_html"
	}
	return map[string]any{
		"id": id, "siteId": "st_1", "status": status, "zipBytes": 1234, "bytes": 5678, "files": files,
		"error": errVal, "createdBy": "m_octo", "createdAt": 1756000200, "updatedAt": 1756000260,
	}
}

func TestSiteListAndGet(t *testing.T) {
	detail := map[string]any{}
	for k, v := range sampleSite {
		detail[k] = v
	}
	detail["currentDeploy"] = sampleDeploy("sd_01j5", "live", 12)
	detail["deploys"] = []any{sampleMove("sd_01j7", "live", "k3x9q2mzp"), sampleDeploy("sd_01j6", "failed", 0), sampleDeploy("sd_01j5", "live", 12)}
	namedDetail := siteWith(namedSite)
	namedDetail["deploys"] = []any{}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /sites": func(recorded) (int, any) {
			return 200, map[string]any{"sites": []any{sampleSite, namedSite, movingSite, emptySite}}
		},
		"GET /sites/st_2":           func(recorded) (int, any) { return 200, namedDetail },
		"GET /projects/prj_1/sites": func(recorded) (int, any) { return 200, map[string]any{"sites": []any{sampleSite}} },
		"GET /sites/st_1":           func(recorded) (int, any) { return 200, detail },
		"GET /sites/st_1/deploys": func(recorded) (int, any) {
			return 200, map[string]any{"deploys": detail["deploys"]}
		},
	}, nil, nil, nil))
	out, _, err := run(t, f, "site", "ls")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_list", out)
	out, _, err = run(t, f, "site", "get", "game-web")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_get", out)
	// A named site links its own host and still lists the path URL.
	out, _, err = run(t, f, "site", "get", "st_2")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_get_named", out)
	out, _, err = run(t, f, "site", "deploys", "st_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_deploys", out)
	// A name needs a project; an id passes straight through.
	if !strings.HasPrefix(f.reqs[len(f.reqs)-1].Path, "/sites/st_1/deploys") {
		t.Fatalf("id was resolved instead of used: %s", f.reqs[len(f.reqs)-1].Path)
	}
}

func TestSiteDeployZipsAndPolls(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":          "<p>hi</p>",
		"assets/app-1.js":     "console.log(1)",
		".DS_Store":           "junk",
		"config.json":         `{"apiBase":"x"}`,
		"nested/.git/HEAD":    "ref",
		"nested/deep/x.txt":   "x",
		"assets/app-1.js.map": "{}",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var uploaded []byte
	polls := 0
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /sites/st_1/deploys": func(r recorded) (int, any) {
			if r.Body["size"] == nil {
				return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "size"}}
			}
			return 201, map[string]any{
				"deployId": "sd_new", "url": f.srv.URL + "/s3put", "method": "PUT",
				"headers":   map[string]string{"content-type": "application/zip", "content-length": fmt.Sprint(r.Body["size"])},
				"expiresAt": 1756003600,
			}
		},
		"POST /sites/st_1/deploys/sd_new/commit": func(recorded) (int, any) { return 202, sampleDeploy("sd_new", "queued", 0) },
		"GET /sites/st_1/deploys/sd_new": func(recorded) (int, any) {
			polls++
			if polls < 2 {
				return 200, sampleDeploy("sd_new", "extracting", 0)
			}
			return 200, sampleDeploy("sd_new", "live", 4)
		},
		"GET /sites/st_1": func(recorded) (int, any) { return 200, sampleSite },
	}, nil, nil, nil))
	// The fake decodes JSON bodies only; wrap its handler to capture the raw PUT.
	inner := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/s3put" {
			uploaded, _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
			return
		}
		inner.ServeHTTP(w, r)
	})

	out, _, err := run(t, f, "site", "deploy", "st_1", dir, "--exclude", "*.map")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "live: https://dev-g.yyt.life/k3x9q2mzp/ (4 files") {
		t.Fatalf("output lacks the live URL:\n%s", out)
	}
	if polls != 2 {
		t.Fatalf("expected two polls, got %d", polls)
	}
	zr, err := zip.NewReader(bytes.NewReader(uploaded), int64(len(uploaded)))
	if err != nil {
		t.Fatalf("uploaded bytes are not a zip: %v", err)
	}
	var names []string
	for _, e := range zr.File {
		names = append(names, e.Name)
	}
	want := "assets/app-1.js config.json index.html nested/deep/x.txt"
	if strings.Join(names, " ") != want {
		t.Fatalf("zip entries %q, want %q", strings.Join(names, " "), want)
	}
	rc, _ := zr.File[2].Open()
	body, _ := io.ReadAll(rc)
	if string(body) != "<p>hi</p>" {
		t.Fatalf("index.html body %q", body)
	}
}

func TestSiteDeployReportsFailure(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var f *fakeConsole
	withProject(t)
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /sites/st_1/deploys": func(r recorded) (int, any) {
			return 201, map[string]any{"deployId": "sd_bad", "url": f.srv.URL + "/s3put", "method": "PUT", "headers": map[string]string{}}
		},
		"PUT /s3put":                             func(recorded) (int, any) { return 200, nil },
		"POST /sites/st_1/deploys/sd_bad/commit": func(recorded) (int, any) { return 202, sampleDeploy("sd_bad", "queued", 0) },
		"GET /sites/st_1/deploys/sd_bad":         func(recorded) (int, any) { return 200, sampleDeploy("sd_bad", "failed", 0) },
	}, nil, nil, nil))
	_, _, err := run(t, f, "site", "deploy", "st_1", dir)
	if err == nil || !strings.Contains(err.Error(), "zip_no_index_html") {
		t.Fatalf("expected the failure code in the error, got %v", err)
	}
	// A zip file is uploaded as-is; anything else is refused before any request.
	if _, _, err := run(t, f, "site", "deploy", "st_1", filepath.Join(dir, "page.html")); err == nil || !strings.Contains(err.Error(), "neither a directory nor a .zip") {
		t.Fatalf("expected a refusal, got %v", err)
	}
}

func TestSiteUpdateRequiresAFlagAndClearsDescription(t *testing.T) {
	var sent map[string]any
	withProject(t)
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /sites/st_1": func(r recorded) (int, any) {
			sent = r.Body
			return 200, sampleSite
		},
	}, nil, nil, nil))
	if _, _, err := run(t, f, "site", "update", "st_1"); err == nil {
		t.Fatal("expected an error when no field is given")
	}
	if _, _, err := run(t, f, "site", "update", "st_1", "--description", ""); err != nil {
		t.Fatal(err)
	}
	// An explicit empty --description clears the field rather than omitting it.
	v, ok := sent["description"]
	if !ok || v != nil {
		t.Fatalf("expected description:null, got %#v", sent)
	}
}

// updateRoutes serves one site whose PATCH answers `patch` and whose GET
// answers `gets` in turn (the last one repeats).
func updateRoutes(sent *[]map[string]any, patch func() (int, any), gets ...map[string]any) map[string]func(recorded) (int, any) {
	n := 0
	return ctxRoutes(map[string]func(recorded) (int, any){
		"PATCH /sites/st_1": func(r recorded) (int, any) {
			*sent = append(*sent, r.Body)
			return patch()
		},
		"GET /sites/st_1": func(recorded) (int, any) {
			g := gets[min(n, len(gets)-1)]
			n++
			return 200, g
		},
	}, nil, nil, nil)
}

func TestSiteUpdateDomainSendsOnlyTheGivenKeys(t *testing.T) {
	withProject(t)
	var sent []map[string]any
	named := siteWith(map[string]any{"slug": "my-game", "domain": "my-game", "hostUrl": "https://my-game.dev-g.yyt.life/", "publicUrl": "https://dev-g.yyt.life/my-game/"})
	f := newFake(t, updateRoutes(&sent, func() (int, any) { return 200, named }, named))
	// An empty site is renamed at once (200): no wait, the new URL printed.
	out, errOut, err := run(t, f, "site", "update", "st_1", "--domain", "My-Game")
	if err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || len(sent[0]) != 1 || sent[0]["domain"] != "My-Game" {
		t.Fatalf("body %v, want only the domain", sent)
	}
	if !strings.Contains(out, "url:         https://my-game.dev-g.yyt.life/") || strings.Contains(errOut, "queued") {
		t.Fatalf("stdout %q stderr %q", out, errOut)
	}
	// --clear-domain is an explicit null; nothing else rides along.
	if _, _, err := run(t, f, "site", "update", "st_1", "--clear-domain"); err != nil {
		t.Fatal(err)
	}
	if v, ok := sent[1]["domain"]; !ok || v != nil || len(sent[1]) != 1 {
		t.Fatalf("expected {domain:null}, got %#v", sent[1])
	}
	// A rename or a description alone never carries the domain.
	if _, _, err := run(t, f, "site", "update", "st_1", "--name", "web2"); err != nil {
		t.Fatal(err)
	}
	if _, ok := sent[2]["domain"]; ok {
		t.Fatalf("domain sent without --domain: %v", sent[2])
	}
	// Refused locally, before any request.
	n := len(f.reqs)
	for _, args := range [][]string{
		{"site", "update", "st_1", "--domain", " "},
		{"site", "update", "st_1", "--domain", "a", "--clear-domain"},
	} {
		if _, _, err := run(t, f, args...); err == nil {
			t.Fatalf("%v: expected a refusal", args)
		}
	}
	if len(f.reqs) != n {
		t.Fatal("a refused flag set must not reach the API")
	}
}

func TestSiteUpdateDomainNeedsAnExplicitContext(t *testing.T) {
	f := newFake(t, ctxRoutes(nil, nil, nil, nil))
	if _, _, err := run(t, f, "site", "update", "game-web", "--domain", "my-game"); err == nil || !strings.Contains(err.Error(), "no team context") {
		t.Fatalf("err = %v, want a context error", err)
	}
	for _, r := range f.reqs {
		if r.Method != http.MethodGet {
			t.Fatalf("unexpected write %s %s", r.Method, r.Path)
		}
	}
}

func TestSiteUpdateDomainWaitsForTheMove(t *testing.T) {
	withProject(t)
	var sent []map[string]any
	moving := siteWith(map[string]any{"busy": true, "movingTo": "my-game"})
	done := siteWith(map[string]any{"slug": "my-game", "domain": "my-game", "hostUrl": "https://my-game.dev-g.yyt.life/", "publicUrl": "https://dev-g.yyt.life/my-game/"})
	done["deploys"] = []any{sampleMove("sd_mv", "live", "my-game")}
	f := newFake(t, updateRoutes(&sent, func() (int, any) { return 202, moving }, done))
	out, errOut, err := run(t, f, "site", "update", "st_1", "--domain", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut, "move to my-game queued") {
		t.Fatalf("stderr %q", errOut)
	}
	if !strings.Contains(out, "url:         https://my-game.dev-g.yyt.life/") || !strings.Contains(out, "move  my-game  live") {
		t.Fatalf("stdout:\n%s", out)
	}
	// --no-wait prints the queued state and polls nothing.
	n := len(f.reqs)
	out, _, err = run(t, f, "site", "update", "st_1", "--domain", "my-game", "--no-wait")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != n+1 || !strings.Contains(out, "movingTo:    my-game") || !strings.Contains(out, "busy:        true") {
		t.Fatalf("reqs %d→%d stdout:\n%s", n, len(f.reqs), out)
	}
}

func TestSiteUpdateDomainRereadsABusyViewWithoutATarget(t *testing.T) {
	withProject(t)
	busy := siteWith(map[string]any{"busy": true})
	moving := siteWith(map[string]any{"busy": true, "movingTo": "my-game"})
	done := siteWith(map[string]any{"slug": "my-game", "domain": "my-game", "hostUrl": "https://my-game.dev-g.yyt.life/", "publicUrl": "https://dev-g.yyt.life/my-game/"})
	done["deploys"] = []any{sampleMove("sd_mv", "live", "my-game")}
	// The re-read names the target: waited for like any queued move.
	var sent []map[string]any
	f := newFake(t, updateRoutes(&sent, func() (int, any) { return 202, busy }, moving, done))
	out, errOut, err := run(t, f, "site", "update", "st_1", "--domain", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut, "move to my-game queued") || !strings.Contains(out, "url:         https://my-game.dev-g.yyt.life/") {
		t.Fatalf("stdout:\n%s\nstderr: %s", out, errOut)
	}
	// Still no target after one re-read: printed as is, no polling.
	sent = nil
	f = newFake(t, updateRoutes(&sent, func() (int, any) { return 200, busy }, busy))
	out, errOut, err = run(t, f, "site", "update", "st_1", "--domain", "my-game")
	if err != nil {
		t.Fatal(err)
	}
	if gets := countReqs(f, "GET /sites/st_1"); gets != 1 || strings.Contains(errOut, "queued") || !strings.Contains(out, "busy:        true") {
		t.Fatalf("gets %d stdout:\n%s\nstderr: %s", gets, out, errOut)
	}
}

func TestSiteUpdateWithoutDomainNeverWaits(t *testing.T) {
	withProject(t)
	var sent []map[string]any
	moving := siteWith(map[string]any{"busy": true, "movingTo": "my-game"})
	f := newFake(t, updateRoutes(&sent, func() (int, any) { return 200, moving }, moving))
	_, errOut, err := run(t, f, "site", "update", "st_1", "--name", "web2")
	if err != nil {
		t.Fatal(err)
	}
	if gets := countReqs(f, "GET /sites/st_1"); gets != 0 || strings.Contains(errOut, "queued") {
		t.Fatalf("a rename waited for someone else's move: gets %d stderr %q", gets, errOut)
	}
}

// countReqs counts the fake's requests to one `METHOD /path`.
func countReqs(f *fakeConsole, route string) int {
	n := 0
	for _, r := range f.reqs {
		if r.Method+" "+r.Path == route {
			n++
		}
	}
	return n
}

func TestSiteUpdateDomainReportsAFailedMove(t *testing.T) {
	withProject(t)
	var sent []map[string]any
	moving := siteWith(map[string]any{"busy": true, "movingTo": "my-game"})
	failed := siteWith(nil)
	failed["deploys"] = []any{sampleMove("sd_mv", "failed", "my-game"), sampleDeploy("sd_01j5", "live", 12)}
	f := newFake(t, updateRoutes(&sent, func() (int, any) { return 202, moving }, failed))
	out, _, err := run(t, f, "site", "update", "st_1", "--domain", "my-game")
	if err == nil || !strings.Contains(err.Error(), "move sd_mv to my-game failed: copy_failed") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out, "sd_mv") {
		t.Fatalf("the failed move row is missing:\n%s", out)
	}
}

func TestSiteUpdateDomainRefusalsCarryAHint(t *testing.T) {
	withProject(t)
	for _, tc := range []struct {
		status  int
		details any
		want    string
	}{
		{409, map[string]any{"reason": "domain_taken"}, "stays with the team that used it"},
		{409, map[string]any{"reason": "domain_cap", "names": []any{map[string]any{"name": "one", "releasedAt": nil}, map[string]any{"name": "two", "releasedAt": 1}}}, "(one, two); reclaiming one"},
		{409, map[string]any{"reason": "domain_cleaning"}, "still being deleted"},
		{429, map[string]any{"retryAfterMs": 1000}, "one name request per team per second"},
	} {
		var sent []map[string]any
		f := newFake(t, updateRoutes(&sent, func() (int, any) {
			return tc.status, map[string]any{"error": map[string]any{"code": "conflict", "message": "refused", "details": tc.details}}
		}, sampleSite))
		_, _, err := run(t, f, "site", "update", "st_1", "--domain", "my-game")
		if err == nil || !strings.Contains(err.Error(), "hint: ") || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%d %v: err = %v", tc.status, tc.details, err)
		}
		var ae *api.Error
		if !errors.As(err, &ae) || ae.Status != tc.status {
			t.Fatalf("the api error (exit code) was lost: %v", err)
		}
	}
	// A plain 409 (a deploy in flight) gets no name hint.
	var sent []map[string]any
	f := newFake(t, updateRoutes(&sent, func() (int, any) {
		return 409, map[string]any{"error": map[string]any{"code": "conflict", "message": "a deploy is in flight; retry later"}}
	}, sampleSite))
	if _, _, err := run(t, f, "site", "update", "st_1", "--domain", "my-game"); err == nil || strings.Contains(err.Error(), "hint:") {
		t.Fatalf("err = %v", err)
	}
}

func TestSiteNameShowAndRelease(t *testing.T) {
	var reason any
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /admin/site-names/squat": func(recorded) (int, any) {
			return 200, map[string]any{
				"name": "squat", "teamId": "team_9", "kind": "name", "createdBy": "m_x", "createdAt": 1756000000,
				"releasedAt": 1756000100, "served": true, "purgedAt": nil,
			}
		},
		"POST /admin/site-names/squat/release": func(r recorded) (int, any) {
			reason = r.Body["reason"]
			return 204, nil
		},
	})
	out, _, err := run(t, f, "site", "name", "show", "Squat")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "site_name_show", out)
	// The reason is required and checked before any request.
	n := len(f.reqs)
	if _, _, err := run(t, f, "site", "name", "release", "squat"); err == nil {
		t.Fatal("expected --reason to be required")
	}
	if _, _, err := run(t, f, "site", "name", "release", "squat", "--reason", "  "); err == nil {
		t.Fatal("expected a blank reason to be refused")
	}
	if len(f.reqs) != n {
		t.Fatal("a refused release must not reach the API")
	}
	out, _, err = run(t, f, "site", "name", "release", "squat", "--reason", " squatter ")
	if err != nil {
		t.Fatal(err)
	}
	if out != "released squat\n" || reason != "squatter" {
		t.Fatalf("out %q reason %v", out, reason)
	}
}

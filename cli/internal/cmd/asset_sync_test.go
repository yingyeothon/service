package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
)

// noSleep makes retries and re-commits instant, recording what they waited.
func noSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var waits []time.Duration
	var mu sync.Mutex
	prev := sleepFor
	sleepFor = func(_ context.Context, d time.Duration) error {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { sleepFor = prev })
	return &waits
}

func shaOf(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

var liveBundle = map[string]any{
	"id": "ab_1", "name": "content", "mode": "live", "teamId": "team_1", "teamName": "dooroo",
	"projectId": "prj_1", "projectName": "game", "createdAt": 1756000000, "updatedAt": 1756000100,
	"versions": []any{}, "files": 0, "bytes": 0,
}

func liveFile(path, sha string, mutable bool, staleSince any) map[string]any {
	return map[string]any{
		"id": "af_" + path, "bundleId": "ab_1", "version": "", "path": path,
		"url": "https://dev-d.yyt.life/assets/ab_1/" + path, "objectKey": "assets/ab_1/" + path,
		"contentType": "application/json", "size": 3, "sha256": sha, "mutable": mutable,
		"staleSince": staleSince, "createdAt": 1756000200,
	}
}

// s3Fake records presigned PUTs: path → the headers and body it received.
type s3Fake struct {
	srv  *httptest.Server
	mu   sync.Mutex
	puts map[string]http.Header
	body map[string]string
	fail int // answer this many PUTs with 503 first
	// forbid answers a path's next N PUTs with 403 (a lapsed signature).
	forbid map[string]int
}

func newS3Fake(t *testing.T) *s3Fake {
	s := &s3Fake{puts: map[string]http.Header{}, body: map[string]string{}}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.fail > 0 {
			s.fail--
			w.WriteHeader(503)
			return
		}
		if s.forbid[r.URL.Path] > 0 {
			s.forbid[r.URL.Path]--
			w.WriteHeader(403)
			return
		}
		s.puts[r.URL.Path] = r.Header.Clone()
		s.body[r.URL.Path] = string(b)
		w.WriteHeader(200)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func TestAssetCreateMode(t *testing.T) {
	withProject(t)
	var sent map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/assets/bundles": func(r recorded) (int, any) { sent = r.Body; return 201, liveBundle },
	}, nil, nil, nil))
	out, _, err := run(t, f, "asset", "create", "content", "--mode", "live")
	if err != nil {
		t.Fatal(err)
	}
	if sent["mode"] != "live" || !strings.Contains(out, "mode:        live") {
		t.Fatalf("sent %v, out %s", sent, out)
	}
	// The default sends no `mode`: an older console's strict body refuses it.
	if _, _, err := run(t, f, "asset", "create", "maps"); err != nil {
		t.Fatal(err)
	}
	if _, has := sent["mode"]; has {
		t.Fatalf("a versioned create sent %v", sent)
	}
	n := len(f.reqs)
	if _, _, err := run(t, f, "asset", "create", "content", "--mode", "fast"); err == nil || !strings.Contains(err.Error(), "--mode") {
		t.Fatalf("err=%v", err)
	}
	if len(f.reqs) != n {
		t.Fatal("a bad --mode must cost no request")
	}
}

func TestAssetFilesOfALiveBundle(t *testing.T) {
	var pages []string
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /assets/bundles/ab_1/files": func(r recorded) (int, any) {
			pages = append(pages, r.Path)
			if !strings.Contains(r.Path, "cursor=") {
				return 200, map[string]any{"files": []any{liveFile("a.json", shaOf("a"), false, nil)}, "next": "a.json"}
			}
			return 200, map[string]any{"files": []any{liveFile("m.json", shaOf("m"), true, 1756000300)}, "next": nil}
		},
	})
	out, _, err := run(t, f, "asset", "files", "ab_1")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "asset_files_live", out)
	if strings.Join(pages, " ") != "/assets/bundles/ab_1/files?limit=1000 /assets/bundles/ab_1/files?limit=1000&cursor=a.json" {
		t.Errorf("pages = %v", pages)
	}
	out, _, err = run(t, f, "asset", "files", "ab_1", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Files []assetFile `json:"files"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || len(v.Files) != 2 || !v.Files[1].Mutable || v.Files[1].StaleSince == nil || *v.Files[0].SHA256 != shaOf("a") {
		t.Fatalf("json %s (%v)", out, err)
	}
}

func TestAssetRmChunksByCountAndSize(t *testing.T) {
	var bodies []int
	var sent [][]any
	f := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /assets/bundles/ab_1/files": func(r recorded) (int, any) {
			b, _ := json.Marshal(r.Body)
			bodies = append(bodies, len(b))
			ps := r.Body["paths"].([]any)
			sent = append(sent, ps)
			res := map[string]any{"deleted": ps, "missing": []any{}, "skipped": []any{}, "failed": []any{}}
			if len(sent) == 1 {
				res["deleted"], res["missing"] = ps[1:], ps[:1]
			}
			return 200, res
		},
	})
	// 400 paths of ~190 characters: well under 1,000, but ~77 KB of JSON.
	args := []string{"asset", "rm", "ab_1"}
	for i := 0; i < 400; i++ {
		args = append(args, fmt.Sprintf("dir/%s-%03d.json", strings.Repeat("x", 180), i))
	}
	out, _, err := run(t, f, args...)
	if err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || len(sent[0])+len(sent[1]) != 400 {
		t.Fatalf("calls %d", len(sent))
	}
	for _, n := range bodies {
		if n > 64<<10 {
			t.Fatalf("a body of %d bytes passes the console's 64 KiB cap", n)
		}
	}
	if !strings.HasPrefix(out, "deleted 399\nmissing 1: dir/") {
		t.Fatalf("out %q", out[:60])
	}
	if got := chunkBySize([]string{"a", "b", "c"}, 2, 1000); len(got) != 2 || len(got[1]) != 1 {
		t.Fatalf("count chunks %v", got)
	}

	failing := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /assets/bundles/ab_1/files": func(recorded) (int, any) {
			return 200, map[string]any{"deleted": []any{}, "missing": []any{}, "skipped": []any{}, "failed": []any{"a.json"}}
		},
	})
	if _, _, err := run(t, failing, "asset", "rm", "ab_1", "a.json"); err == nil || !strings.Contains(err.Error(), "could not be deleted") {
		t.Fatalf("err=%v", err)
	}
	// One argument is not "delete the bundle": it is a usage error.
	if _, _, err := run(t, failing, "asset", "rm", "ab_1"); err == nil {
		t.Fatal("asset rm with no path must refuse")
	}
}

func TestAssetDeletesRepeatOn202(t *testing.T) {
	calls := map[string]int{}
	answer := func(r recorded) (int, any) {
		calls[r.Path]++
		if calls[r.Path] < 3 {
			return 202, map[string]any{"done": false, "deleted": 2000, "failed": 0}
		}
		return 204, nil
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /assets/bundles/ab_1":             answer,
		"DELETE /assets/bundles/ab_1/versions/v1": answer,
	})
	out, errOut, err := run(t, f, "asset", "delete", "ab_1")
	if err != nil || out != "deleted ab_1\n" || calls["/assets/bundles/ab_1"] != 3 {
		t.Fatalf("delete: %v %q %v", err, out, calls)
	}
	if !strings.Contains(errOut, "deleted 4000 object(s) so far") {
		t.Errorf("progress %q", errOut)
	}
	out, _, err = run(t, f, "asset", "rm-version", "ab_1", "v1")
	if err != nil || out != "deleted ab_1/v1\n" || calls["/assets/bundles/ab_1/versions/v1"] != 3 {
		t.Fatalf("rm-version: %v %q %v", err, out, calls)
	}
}

func TestPlanSync(t *testing.T) {
	sp := func(s string) *string { return &s }
	stale := int64(1756000000)
	remote := []assetFile{
		{Path: "same.png", SHA256: sp(shaOf("same"))},
		{Path: "back.png", SHA256: sp(shaOf("back")), StaleSince: &stale},
		{Path: "changed.png", SHA256: sp(shaOf("old"))},
		{Path: "manifest.json", SHA256: sp(shaOf("m0")), Mutable: true},
		{Path: "flip.json", SHA256: sp(shaOf("f")), Mutable: true},
		{Path: "gone.png", SHA256: sp(shaOf("gone"))},
		{Path: "old.png", SHA256: sp(shaOf("old")), StaleSince: &stale},
	}
	local := []localFile{
		{Path: "same.png", SHA256: shaOf("same")},
		{Path: "back.png", SHA256: shaOf("back")},
		{Path: "changed.png", SHA256: shaOf("new")},
		{Path: "manifest.json", SHA256: shaOf("m1"), Mutable: true},
		{Path: "flip.json", SHA256: shaOf("f")},
		{Path: "new.png", SHA256: shaOf("new")},
	}
	p := planSync(local, remote, true, "")
	if fmt.Sprint(p.Skip, p.Fresh, paths(p.Upload), paths(p.Replace), p.Stale, p.Prune) != "[same.png back.png] [back.png] [new.png] [manifest.json] [gone.png] []" {
		t.Fatalf("plan %v %v %v %v %v %v", p.Skip, p.Fresh, paths(p.Upload), paths(p.Replace), p.Stale, p.Prune)
	}
	if p.ifSHA["manifest.json"] != shaOf("m0") {
		t.Errorf("ifSha256 %v", p.ifSHA)
	}
	if len(p.Conflicts) != 2 || !strings.HasPrefix(p.Conflicts[0], "changed.png: already there with other bytes") || !strings.Contains(p.Conflicts[1], "flip.json: the bundle holds it as mutable") {
		t.Errorf("conflicts %v", p.Conflicts)
	}
	// --prune deletes only what was already stale; --prune=now everything missing.
	if p := planSync(local, remote, true, "stale"); fmt.Sprint(p.Stale, p.Prune) != "[gone.png] [old.png]" {
		t.Errorf("prune %v %v", p.Stale, p.Prune)
	}
	if p := planSync(local, remote, true, "now"); fmt.Sprint(p.Stale, p.Prune) != "[] [gone.png old.png]" {
		t.Errorf("prune=now %v %v", p.Stale, p.Prune)
	}
	// A versioned sync never marks or prunes: other versions are not its business.
	if p := planSync(local, remote, false, ""); len(p.Stale)+len(p.Prune) != 0 {
		t.Errorf("versioned %v %v", p.Stale, p.Prune)
	}
	// A file uploaded without a SHA-256 cannot be compared.
	if p := planSync([]localFile{{Path: "x.png", SHA256: shaOf("x")}}, []assetFile{{Path: "x.png"}}, false, ""); len(p.Conflicts) != 1 {
		t.Errorf("no-sha %v", p.Conflicts)
	}
}

func TestMatchesAny(t *testing.T) {
	for _, tc := range []struct {
		globs []string
		rel   string
		want  bool
	}{
		{[]string{"manifest.json"}, "manifest.json", true},
		{[]string{"manifest.json"}, "sub/manifest.json", true},
		{[]string{"sub/*.json"}, "sub/a.json", true},
		{[]string{"sub/*.json"}, "other/a.json", false},
		{[]string{"*.txt"}, "notes/a.txt", true},
		{nil, "a.json", false},
	} {
		if got, err := matchesAny(tc.globs, tc.rel); err != nil || got != tc.want {
			t.Errorf("%v %s = %v %v", tc.globs, tc.rel, got, err)
		}
	}
	if _, err := matchesAny([]string{"["}, "a"); err == nil {
		t.Error("a bad glob must refuse")
	}
}

// liveSyncRoutes is a live bundle whose listing is `remote`, recording every
// presign and commit, with S3 at `s3`.
func liveSyncRoutes(t *testing.T, s3 *s3Fake, remote []any, presigns *[]map[string]any, commits *[][]any, unavailableOnce map[string]bool) map[string]func(recorded) (int, any) {
	t.Helper()
	n := 0
	pathOf := map[string]string{}
	return map[string]func(recorded) (int, any){
		"GET /assets/bundles/ab_1": func(recorded) (int, any) { return 200, liveBundle },
		"GET /assets/bundles/ab_1/files": func(recorded) (int, any) {
			return 200, map[string]any{"files": remote, "next": nil}
		},
		"POST /assets/bundles/ab_1/files": func(r recorded) (int, any) {
			*presigns = append(*presigns, r.Body)
			var ups []any
			for _, raw := range r.Body["files"].([]any) {
				spec := raw.(map[string]any)
				n++
				id := fmt.Sprintf("u%d", n)
				p := spec["path"].(string)
				pathOf[id] = p
				ups = append(ups, map[string]any{
					"path": p, "uploadId": id, "url": s3.srv.URL + "/put/" + p, "method": "PUT",
					"headers": map[string]string{"content-type": "application/json", "x-amz-checksum-sha256": "b64-" + spec["sha256"].(string)[:8]},
				})
			}
			return 201, map[string]any{"uploads": ups}
		},
		"POST /assets/uploads/commit": func(r recorded) (int, any) {
			ids := r.Body["ids"].([]any)
			*commits = append(*commits, ids)
			var res []any
			for _, raw := range ids {
				id := raw.(string)
				if unavailableOnce[id] {
					delete(unavailableOnce, id)
					res = append(res, map[string]any{"uploadId": id, "error": map[string]any{"code": "unavailable", "message": "commit it again"}})
					continue
				}
				res = append(res, map[string]any{"uploadId": id, "file": liveFile(pathOf[id], "", false, nil)})
			}
			return 200, map[string]any{"results": res}
		},
	}
}

func TestAssetSyncLive(t *testing.T) {
	waits := noSleep(t)
	s3 := newS3Fake(t)
	s3.fail = 1 // the first PUT is a 503: retried
	dir := writeTree(t, map[string]string{
		"keep.png":      "keep",
		"new.png":       "new",
		"manifest.json": `{"v":2}`,
		".DS_Store":     "never",
	})
	remote := []any{
		liveFile("keep.png", shaOf("keep"), false, 1756000000),
		liveFile("manifest.json", shaOf(`{"v":1}`), true, nil),
		liveFile("gone.png", shaOf("gone"), false, nil),
		liveFile("old.png", shaOf("old"), false, 1756000000),
	}
	var presigns []map[string]any
	var commits [][]any
	routes := liveSyncRoutes(t, s3, remote, &presigns, &commits, map[string]bool{"u1": true})
	var marks, deletes []map[string]any
	routes["PATCH /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		marks = append(marks, r.Body)
		return 200, map[string]any{"stale": 1, "fresh": 1}
	}
	routes["DELETE /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		deletes = append(deletes, r.Body)
		return 200, map[string]any{"deleted": r.Body["paths"], "missing": []any{}, "skipped": []any{}, "failed": []any{}}
	}
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--prune", "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "asset_sync_live", out)
	// Immutable first, then the manifest with the SHA-256 it replaces.
	if len(presigns) != 2 {
		t.Fatalf("presigns %v", presigns)
	}
	first := presigns[0]["files"].([]any)
	if len(first) != 1 || first[0].(map[string]any)["path"] != "new.png" || first[0].(map[string]any)["sha256"] != shaOf("new") || first[0].(map[string]any)["mutable"] != nil {
		t.Errorf("first presign %v", first)
	}
	second := presigns[1]["files"].([]any)[0].(map[string]any)
	if second["path"] != "manifest.json" || second["mutable"] != true || second["ifSha256"] != shaOf(`{"v":1}`) {
		t.Errorf("manifest presign %v", second)
	}
	if _, ok := presigns[0]["version"]; ok {
		t.Error("a live sync sends no version")
	}
	// The `unavailable` commit came back again, alone.
	if fmt.Sprint(commits) != "[[u1] [u1] [u2]]" {
		t.Errorf("commits %v", commits)
	}
	if s3.body["/put/new.png"] != "new" || s3.puts["/put/new.png"].Get("x-amz-checksum-sha256") != "b64-"+shaOf("new")[:8] {
		t.Errorf("PUT %v %v", s3.body, s3.puts["/put/new.png"])
	}
	if fmt.Sprint(marks) != "[map[fresh:[keep.png]] map[stale:[gone.png]]]" {
		t.Errorf("marks %v", marks)
	}
	if fmt.Sprint(deletes) != "[map[paths:[old.png] stale:true]]" {
		t.Errorf("deletes %v", deletes)
	}
	if len(*waits) < 2 {
		t.Errorf("the 503 and the re-commit should both have waited: %v", *waits)
	}
}

func TestAssetSyncConflictSendsNothing(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"a.png": "changed", "b.png": "new"})
	var presigns []map[string]any
	var commits [][]any
	f := newFake(t, liveSyncRoutes(t, s3, []any{liveFile("a.png", shaOf("original"), false, nil)}, &presigns, &commits, nil))
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0")
	if err == nil || !strings.Contains(err.Error(), "1 conflict(s); nothing was sent") {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(out, "conflict a.png: already there with other bytes") {
		t.Errorf("out %s", out)
	}
	for _, r := range f.reqs {
		if r.Method != http.MethodGet {
			t.Fatalf("a conflicting sync sent %s %s", r.Method, r.Path)
		}
	}
}

func TestAssetSyncDryRun(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"a.png": "a", "m.json": "{}"})
	var presigns []map[string]any
	var commits [][]any
	f := newFake(t, liveSyncRoutes(t, s3, []any{liveFile("z.png", shaOf("z"), false, 1756000000)}, &presigns, &commits, nil))
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "m.json", "--prune=now", "--dry-run", "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "asset_sync_dry", out)
	for _, r := range f.reqs {
		if r.Method != http.MethodGet {
			t.Fatalf("a dry run sent %s %s", r.Method, r.Path)
		}
	}
}

func TestAssetSyncVersioned(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"map.json": "{}"})
	versioned := map[string]any{"id": "ab_1", "name": "maps", "mode": "versioned"}
	var presigns []map[string]any
	var commits [][]any
	var listed []string
	routes := liveSyncRoutes(t, s3, []any{}, &presigns, &commits, nil)
	routes["GET /assets/bundles/ab_1"] = func(recorded) (int, any) { return 200, versioned }
	routes["GET /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		listed = append(listed, r.Path)
		return 200, map[string]any{"files": []any{}, "next": nil}
	}
	f := newFake(t, routes)
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0"); err == nil || !strings.Contains(err.Error(), "pass --version") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--version", "v2", "--mutable", "map.json", "--rate", "0"); err == nil || !strings.Contains(err.Error(), "live bundle only") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--version", "v2", "--rate", "0"); err != nil {
		t.Fatal(err)
	}
	// A new version lists empty rather than 404ing, and the presign names it.
	if len(listed) != 1 || listed[0] != "/assets/bundles/ab_1/files?limit=1000&version=v2" {
		t.Errorf("listed %v", listed)
	}
	if len(presigns) != 1 || presigns[0]["version"] != "v2" {
		t.Errorf("presigns %v", presigns)
	}

	liveF := newFake(t, liveSyncRoutes(t, s3, []any{}, &presigns, &commits, nil))
	if _, _, err := run(t, liveF, "asset", "sync", "ab_1", dir, "--version", "v2", "--rate", "0"); err == nil || !strings.Contains(err.Error(), "takes no --version") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, liveF, "asset", "sync", "ab_1", dir, "--prune=later", "--rate", "0"); err == nil || !strings.Contains(err.Error(), "--prune") {
		t.Fatalf("err=%v", err)
	}
}

func TestAssetSyncStopsBeforeTheManifestWhenAFileFails(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"a.png": "a", "m.json": "{}"})
	var presigns []map[string]any
	var commits [][]any
	routes := liveSyncRoutes(t, s3, []any{}, &presigns, &commits, nil)
	routes["POST /assets/uploads/commit"] = func(r recorded) (int, any) {
		commits = append(commits, r.Body["ids"].([]any))
		return 200, map[string]any{"results": []any{map[string]any{"uploadId": "u1", "error": map[string]any{"code": "conflict", "message": "tombstoned"}}}}
	}
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "m.json", "--rate", "0")
	if err == nil || !strings.Contains(err.Error(), "mutable files were not sent") {
		t.Fatalf("err=%v", err)
	}
	if len(presigns) != 1 || !strings.Contains(out, "failed a.png: conflict: tombstoned") {
		t.Errorf("presigns %v out %s", presigns, out)
	}
}

func TestRetryPolicy(t *testing.T) {
	waits := noSleep(t)
	ctx := context.Background()
	p := retryPolicy{attempts: 5, base: time.Millisecond, max: 4 * time.Millisecond}
	calls := 0
	err := p.do(ctx, func() error {
		calls++
		if calls < 3 {
			return &api.Error{Status: 503, Code: "unavailable"}
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("503 twice then ok: %v after %d", err, calls)
	}
	calls = 0
	err = p.do(ctx, func() error { calls++; return &api.Error{Status: 400, Code: "bad_request"} })
	if err == nil || calls != 1 {
		t.Fatalf("a 400 is final: %v after %d", err, calls)
	}
	calls = 0
	err = p.do(ctx, func() error { calls++; return &httpStatusError{Op: "upload PUT", Status: 500} })
	if err == nil || calls != 5 {
		t.Fatalf("five attempts at most: %v after %d", err, calls)
	}
	// The console's hint wins over a shorter backoff.
	*waits = nil
	calls = 0
	_ = p.do(ctx, func() error {
		calls++
		if calls == 1 {
			return &api.Error{Status: 429, Code: "rate_limited", Details: json.RawMessage(`{"retryAfterMs":500}`)}
		}
		return nil
	})
	if len(*waits) != 1 || (*waits)[0] != 500*time.Millisecond {
		t.Errorf("waits %v", *waits)
	}
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{&api.Error{Status: 404}, false},
		{&api.Error{Status: 429}, true},
		{&httpStatusError{Status: 403}, false},
		{io.ErrUnexpectedEOF, true},
		{fmt.Errorf("wrapped: %w", context.Canceled), false},
		{errors.New("decode failed"), false},
	} {
		if got, _ := retryable(tc.err); got != tc.want {
			t.Errorf("retryable(%v) = %v", tc.err, got)
		}
	}
	r := newRateLimiter(10)
	now := time.Unix(0, 0)
	r.now = func() time.Time { return now }
	*waits = nil
	for i := 0; i < 3; i++ {
		_ = r.wait(ctx)
	}
	if fmt.Sprint(*waits) != "[100ms 200ms]" {
		t.Errorf("rate waits %v", *waits)
	}
}

func TestAssetDownload(t *testing.T) {
	noSleep(t)
	failures := 1
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failures > 0 {
			failures--
			w.WriteHeader(502)
			return
		}
		http.ServeContent(w, r, "f.bin", time.Unix(0, 0), strings.NewReader("abcdefgh"))
	}))
	t.Cleanup(cdn.Close)
	var lookups []string
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /assets/bundles/ab_1": func(recorded) (int, any) { return 200, liveBundle },
		"GET /assets/bundles/ab_1/files": func(r recorded) (int, any) {
			lookups = append(lookups, r.Path)
			if !strings.Contains(r.Path, "path=dir%2Ff.bin") {
				return 200, map[string]any{"files": []any{}}
			}
			file := liveFile("dir/f.bin", shaOf("abcdefgh"), false, nil)
			file["url"] = cdn.URL + "/assets/ab_1/dir/f.bin"
			return 200, map[string]any{"files": []any{file}}
		},
	})
	dst := filepath.Join(t.TempDir(), "out.bin")
	if _, _, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "-o", dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "abcdefgh" {
		t.Fatalf("got %q", b)
	}
	out, _, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--range", "2-5", "-o", "-")
	if err != nil || out != "cdef" {
		t.Fatalf("range: %v %q", err, out)
	}
	if lookups[0] != "/assets/bundles/ab_1/files?path=dir%2Ff.bin" {
		t.Errorf("lookup %v", lookups)
	}
	if _, _, err := run(t, f, "asset", "download", "ab_1", "nope.bin", "-o", dst); err == nil || !strings.Contains(err.Error(), "not in ab_1") {
		t.Fatalf("missing: %v", err)
	}
	if _, _, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--range", "5-2"); err == nil {
		t.Fatal("a backwards range must refuse")
	}
	// No temp file is left beside the output.
	if ents, _ := os.ReadDir(filepath.Dir(dst)); len(ents) != 1 {
		t.Errorf("dir holds %d entries", len(ents))
	}
}

func TestAssetUploadPointsALiveBundleAtSync(t *testing.T) {
	dir := writeTree(t, map[string]string{"map.json": "{}"})
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /assets/bundles/ab_1/files": func(recorded) (int, any) {
			return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": "a live bundle takes no version"}}
		},
	})
	if _, _, err := run(t, f, "asset", "upload", "ab_1", "v1", filepath.Join(dir, "map.json")); err == nil || !strings.Contains(err.Error(), "yyt asset sync ab_1 <dir>") {
		t.Fatalf("upload: %v", err)
	}
	if _, _, err := run(t, f, "asset", "push", "ab_1", "v1", dir); err == nil || !strings.Contains(err.Error(), "yyt asset sync ab_1 <dir>") {
		t.Fatalf("push: %v", err)
	}
}

// failingTransport refuses every request, as a dropped connection would.
type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("connection reset by peer")
}

func TestPutPresignedNeverPrintsTheSignedURL(t *testing.T) {
	cl := &api.Client{HTTP: &http.Client{Transport: failingTransport{}}}
	grant := uploadGrant{
		Method: "PUT",
		URL:    "https://bucket.s3.example/asset-uploads/u1/map.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE%2F20260928&X-Amz-Security-Token=tok&X-Amz-Signature=deadbeef",
	}
	err := putPresigned(context.Background(), cl, grant, strings.NewReader("{}"), 2)
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, leak := range []string{"X-Amz-", "?", "deadbeef", "ASIAEXAMPLE", "bucket.s3.example"} {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("error leaks %q: %v", leak, err)
		}
	}
	// Still a transport failure to the retry policy.
	if again, _ := retryable(err); !again {
		t.Fatalf("redaction lost the error's type: %v", err)
	}
	// A URL that does not even parse is redacted too.
	bad := uploadGrant{Method: "PUT", URL: "https://h/\x7f?X-Amz-Signature=abc%zz"}
	if err := putPresigned(context.Background(), cl, bad, strings.NewReader("{}"), 2); err == nil || strings.Contains(err.Error(), "X-Amz-") {
		t.Fatalf("parse error: %v", err)
	}
}

func TestAssetSyncHoldsMarksAndPrunesWhenTheManifestFails(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"new.png": "new", "manifest.json": `{"v":2}`})
	remote := []any{
		liveFile("manifest.json", shaOf(`{"v":1}`), true, nil),
		liveFile("old.png", shaOf("old"), false, nil),
	}
	var presigns []map[string]any
	var commits [][]any
	routes := liveSyncRoutes(t, s3, remote, &presigns, &commits, nil)
	// The manifest's grants, whichever run minted them.
	manifest := map[any]bool{}
	presign := routes["POST /assets/bundles/ab_1/files"]
	routes["POST /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		status, body := presign(r)
		for _, u := range body.(map[string]any)["uploads"].([]any) {
			if g := u.(map[string]any); g["path"] == "manifest.json" {
				manifest[g["uploadId"]] = true
			}
		}
		return status, body
	}
	commit := routes["POST /assets/uploads/commit"]
	routes["POST /assets/uploads/commit"] = func(r recorded) (int, any) {
		ids := r.Body["ids"].([]any)
		if manifest[ids[0]] { // somebody else replaced it first
			commits = append(commits, ids)
			return 200, map[string]any{"results": []any{map[string]any{"uploadId": ids[0], "error": map[string]any{
				"code": "conflict", "message": `"manifest.json" changed since; sync again`, "details": map[string]any{"path": "manifest.json", "sha256": shaOf("other")},
			}}}}
		}
		return commit(r)
	}
	marked := 0
	routes["PATCH /assets/bundles/ab_1/files"] = func(recorded) (int, any) { marked++; return 200, map[string]any{} }
	routes["DELETE /assets/bundles/ab_1/files"] = func(recorded) (int, any) { marked++; return 200, map[string]any{} }
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--prune=now", "--rate", "0")
	if err == nil || !strings.Contains(err.Error(), "1 file(s) failed") {
		t.Fatalf("err=%v", err)
	}
	if marked != 0 {
		t.Fatal("a failed manifest replace must not mark or prune: the old manifest may name old.png")
	}
	if !strings.Contains(out, "held back 1 stale mark(s) and deletion(s)") || !strings.Contains(out, "uploaded new.png") {
		t.Errorf("out %s", out)
	}
	out, _, _ = run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--prune=now", "--rate", "0", "--json")
	var rep syncReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil || rep.Held != 1 || len(rep.Pruned) != 0 {
		t.Fatalf("json %s (%v)", out, err)
	}
}

func TestAssetSyncRetriesAPresignOnlyWhenRefusedUpFront(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"a.png": "a"})
	for _, tc := range []struct {
		status   int
		presigns int
		ok       bool
	}{
		// 503: the reservations may exist; a second presign would double them.
		{503, 1, false},
		// 429: refused before anything was inserted; safe to ask again.
		{429, 2, true},
	} {
		var presigns []map[string]any
		var commits [][]any
		routes := liveSyncRoutes(t, s3, []any{}, &presigns, &commits, nil)
		presign := routes["POST /assets/bundles/ab_1/files"]
		calls := 0
		routes["POST /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
			calls++
			if calls == 1 {
				return tc.status, map[string]any{"error": map[string]any{"code": "x", "message": "first"}}
			}
			return presign(r)
		}
		f := newFake(t, routes)
		_, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0")
		if calls != tc.presigns || (err == nil) != tc.ok {
			t.Errorf("%d: presigns %d, err %v", tc.status, calls, err)
		}
	}
}

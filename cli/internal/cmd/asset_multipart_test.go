package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// multipartRoutes is a live bundle whose console splits `big.bin` into
// 4-byte parts (the real ceiling is 64 MiB with 32 MiB parts; the CLI only
// follows the grant). `have` are the part numbers S3 already holds.
func multipartRoutes(t *testing.T, s3 *s3Fake, have []int, partReqs *[]map[string]any, commits *[][]any) map[string]func(recorded) (int, any) {
	t.Helper()
	const partSize = 4
	routes := map[string]func(recorded) (int, any){
		"GET /assets/bundles/ab_1": func(recorded) (int, any) { return 200, liveBundle },
		"GET /assets/bundles/ab_1/files": func(recorded) (int, any) {
			return 200, map[string]any{"files": []any{}, "next": nil}
		},
		"POST /assets/bundles/ab_1/files": func(r recorded) (int, any) {
			var ups []any
			for _, raw := range r.Body["files"].([]any) {
				spec := raw.(map[string]any)
				p := spec["path"].(string)
				size := int64(spec["size"].(float64))
				if p == "big.bin" {
					ups = append(ups, map[string]any{
						"path": p, "uploadId": "u1", "key": "assets/ab_1/big.bin", "multipart": true,
						"partSize": partSize, "partCount": (size + partSize - 1) / partSize, "size": size,
						"expiresAt": time.Now().Unix() + 86400,
					})
					continue
				}
				ups = append(ups, map[string]any{
					"path": p, "uploadId": "u2", "url": s3.srv.URL + "/put/" + p, "method": "PUT",
					"headers": map[string]string{"content-type": "application/octet-stream"},
				})
			}
			return 201, map[string]any{"uploads": ups}
		},
		"GET /assets/uploads/u1": func(recorded) (int, any) {
			return 200, map[string]any{
				"id": "u1", "bundleId": "ab_1", "version": "", "path": "big.bin", "status": "pending",
				"multipart": true, "partSize": partSize, "partCount": 3, "size": 10,
				"expiresAt": time.Now().Unix() + 86400,
			}
		},
		"GET /assets/uploads/u1/parts": func(recorded) (int, any) {
			var parts []any
			for _, n := range have {
				size := partSize
				if n == 3 {
					size = 2
				}
				parts = append(parts, map[string]any{"partNumber": n, "size": size, "sha256": "x", "etag": "e"})
			}
			return 200, map[string]any{"status": "pending", "open": true, "partSize": partSize, "partCount": 3, "parts": parts}
		},
		"POST /assets/uploads/u1/parts": func(r recorded) (int, any) {
			*partReqs = append(*partReqs, r.Body)
			var out []any
			for _, raw := range r.Body["parts"].([]any) {
				p := raw.(map[string]any)
				n := int(p["partNumber"].(float64))
				size := partSize
				if n == 3 {
					size = 2
				}
				out = append(out, map[string]any{
					"partNumber": n, "url": fmt.Sprintf("%s/part/big.bin/%d", s3.srv.URL, n), "method": "PUT",
					"headers": map[string]string{"content-length": fmt.Sprint(size), "x-amz-checksum-sha256": "b64-" + p["sha256"].(string)[:8]},
				})
			}
			return 201, map[string]any{"expiresAt": time.Now().Unix() + 3600, "parts": out}
		},
		"POST /assets/uploads/commit": func(r recorded) (int, any) {
			ids := r.Body["ids"].([]any)
			*commits = append(*commits, ids)
			var res []any
			for _, raw := range ids {
				id := raw.(string)
				p := map[string]string{"u1": "big.bin", "u2": "small.bin"}[id]
				res = append(res, map[string]any{"uploadId": id, "file": liveFile(p, "", false, nil)})
			}
			return 200, map[string]any{"results": res}
		},
	}
	return routes
}

func TestAssetSyncMultipart(t *testing.T) {
	noSleep(t)
	cache := t.TempDir()
	t.Setenv("YYT_CACHE", cache)
	s3 := newS3Fake(t)
	s3.fail = 1 // the first part PUT is a 503: retried from its own offset
	dir := writeTree(t, map[string]string{"big.bin": "0123456789", "small.bin": "s"})
	var partReqs []map[string]any
	var commits [][]any
	f := newFake(t, multipartRoutes(t, s3, nil, &partReqs, &commits))
	out, stderr, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "2 uploaded") {
		t.Errorf("out %s", out)
	}
	// Every part was asked for at once, with its own SHA-256.
	if len(partReqs) != 1 {
		t.Fatalf("part requests %v", partReqs)
	}
	asked := partReqs[0]["parts"].([]any)
	if len(asked) != 3 || asked[0].(map[string]any)["sha256"] != shaOf("0123") || asked[2].(map[string]any)["sha256"] != shaOf("89") {
		t.Errorf("asked %v", asked)
	}
	// Each part carried its slice of the file and the signed headers.
	for n, want := range map[int]string{1: "0123", 2: "4567", 3: "89"} {
		p := fmt.Sprintf("/part/big.bin/%d", n)
		if s3.body[p] != want || s3.puts[p].Get("x-amz-checksum-sha256") != "b64-"+shaOf(want)[:8] || s3.puts[p].Get("Content-Length") != fmt.Sprint(len(want)) {
			t.Errorf("part %d: body %q headers %v", n, s3.body[p], s3.puts[p])
		}
	}
	if s3.body["/put/small.bin"] != "s" {
		t.Errorf("small PUT %v", s3.body)
	}
	if fmt.Sprint(commits) != "[[u1 u2]]" {
		t.Errorf("commits %v", commits)
	}
	if !strings.Contains(stderr, "big.bin: uploaded part") {
		t.Errorf("progress goes to stderr: %q", stderr)
	}
	// The resume state is gone once the file is committed.
	if _, err := os.Stat(filepath.Join(cache, "uploads", "ab_1", shaOf("0123456789")+".json")); !os.IsNotExist(err) {
		t.Errorf("resume state kept after commit: %v", err)
	}
}

func TestAssetSyncMultipartResumes(t *testing.T) {
	noSleep(t)
	cache := t.TempDir()
	t.Setenv("YYT_CACHE", cache)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789"})
	// What a run that died after two parts left behind.
	state := uploadState{UploadID: "u1", BundleID: "ab_1", Path: "big.bin", SHA256: shaOf("0123456789"), Size: 10, ExpiresAt: time.Now().Unix() + 86400}
	if err := saveUploadState(state); err != nil {
		t.Fatal(err)
	}
	var partReqs []map[string]any
	var commits [][]any
	f := newFake(t, multipartRoutes(t, s3, []int{1, 3}, &partReqs, &commits))
	_, stderr, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	// No presign: the pending upload was found through the state file.
	for _, r := range f.reqs {
		if r.Method == "POST" && r.Path == "/assets/bundles/ab_1/files" {
			t.Fatal("a resumable upload must not be presigned again")
		}
	}
	if len(partReqs) != 1 || fmt.Sprint(partReqs[0]["parts"]) != fmt.Sprintf("[map[partNumber:2 sha256:%s]]", shaOf("4567")) {
		t.Errorf("only the missing part is asked for: %v", partReqs)
	}
	if s3.body["/part/big.bin/2"] != "4567" || len(s3.body) != 1 {
		t.Errorf("PUTs %v", s3.body)
	}
	if !strings.Contains(stderr, "resuming: 2 of 3") {
		t.Errorf("stderr %q", stderr)
	}
	if fmt.Sprint(commits) != "[[u1]]" {
		t.Errorf("commits %v", commits)
	}
}

func TestAssetSyncMultipartGoneStartsOver(t *testing.T) {
	noSleep(t)
	cache := t.TempDir()
	t.Setenv("YYT_CACHE", cache)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789"})
	if err := saveUploadState(uploadState{UploadID: "u1", BundleID: "ab_1", Path: "big.bin", SHA256: shaOf("0123456789"), Size: 10, ExpiresAt: time.Now().Unix() + 86400}); err != nil {
		t.Fatal(err)
	}
	var partReqs []map[string]any
	var commits [][]any
	routes := multipartRoutes(t, s3, nil, &partReqs, &commits)
	// The console no longer knows the upload (a day passed): the state is dropped.
	routes["GET /assets/uploads/u1"] = func(recorded) (int, any) {
		return 404, map[string]any{"error": map[string]any{"code": "not_found", "message": "upload not found"}}
	}
	f := newFake(t, routes)
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0"); err != nil {
		t.Fatal(err)
	}
	presigned := false
	for _, r := range f.reqs {
		if r.Method == "POST" && r.Path == "/assets/bundles/ab_1/files" {
			presigned = true
		}
	}
	if !presigned || len(s3.body) != 3 {
		t.Errorf("presigned %v, PUTs %v", presigned, s3.body)
	}
	// A state file the next run may not trust is refused up front.
	p, _ := uploadStatePath("ab_1", shaOf("x"))
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"uploadId":"u9","sha256":"other"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if loadUploadState("ab_1", shaOf("x")) != nil {
		t.Error("a state naming another sha256 must be ignored")
	}
	b, _ := json.Marshal(uploadState{UploadID: "u9", SHA256: shaOf("x")})
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if s := loadUploadState("ab_1", shaOf("x")); s == nil || s.UploadID != "u9" {
		t.Error("a well-formed state loads")
	}
}

func TestAssetUploadMultipart(t *testing.T) {
	noSleep(t)
	t.Setenv("YYT_CACHE", t.TempDir())
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789"})
	var partReqs []map[string]any
	var commits [][]any
	routes := multipartRoutes(t, s3, nil, &partReqs, &commits)
	// The single-file presign answers the same grant, unwrapped.
	routes["POST /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		return 201, map[string]any{
			"uploadId": "u1", "key": "assets/ab_1/v1/big.bin", "multipart": true,
			"partSize": 4, "partCount": 3, "size": 10, "expiresAt": time.Now().Unix() + 86400,
		}
	}
	var committed bool
	routes["POST /assets/uploads/u1/commit"] = func(recorded) (int, any) {
		committed = true
		return 200, liveFile("big.bin", shaOf("0123456789"), false, nil)
	}
	f := newFake(t, routes)
	if _, _, err := run(t, f, "asset", "upload", "ab_1", "v1", filepath.Join(dir, "big.bin")); err != nil {
		t.Fatal(err)
	}
	if !committed || len(s3.body) != 3 || s3.body["/part/big.bin/3"] != "89" {
		t.Errorf("committed %v, PUTs %v", committed, s3.body)
	}
}

func TestAssetSyncMultipartCompletingIsCommitOnly(t *testing.T) {
	noSleep(t)
	cache := t.TempDir()
	t.Setenv("YYT_CACHE", cache)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789"})
	if err := saveUploadState(uploadState{UploadID: "u1", BundleID: "ab_1", Path: "big.bin", SHA256: shaOf("0123456789"), Size: 10, ExpiresAt: time.Now().Unix() + 86400}); err != nil {
		t.Fatal(err)
	}
	var partReqs []map[string]any
	var commits [][]any
	routes := multipartRoutes(t, s3, nil, &partReqs, &commits)
	// A commit that died mid-way left the upload `completing`.
	routes["GET /assets/uploads/u1"] = func(recorded) (int, any) {
		return 200, map[string]any{
			"id": "u1", "bundleId": "ab_1", "version": "", "path": "big.bin", "status": "completing",
			"multipart": true, "partSize": 4, "partCount": 3, "size": 10, "expiresAt": time.Now().Unix() + 86400,
		}
	}
	f := newFake(t, routes)
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0"); err != nil {
		t.Fatal(err)
	}
	if len(partReqs) != 0 || len(s3.body) != 0 {
		t.Errorf("a completing upload owes only its commit: parts %v, PUTs %v", partReqs, s3.body)
	}
	if fmt.Sprint(commits) != "[[u1]]" {
		t.Errorf("commits %v", commits)
	}
	for _, r := range f.reqs {
		if r.Method == "POST" && r.Path == "/assets/bundles/ab_1/files" {
			t.Fatal("no presign for a completing upload")
		}
	}
}

func TestAssetSyncFollowsACommittingRefusal(t *testing.T) {
	noSleep(t)
	t.Setenv("YYT_CACHE", t.TempDir())
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789", "small.bin": "s"})
	var partReqs []map[string]any
	var commits [][]any
	routes := multipartRoutes(t, s3, nil, &partReqs, &commits)
	// No resume state on this machine: the presign names the upload to commit.
	var presigns []map[string]any
	inner := routes["POST /assets/bundles/ab_1/files"]
	routes["POST /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		presigns = append(presigns, r.Body)
		for _, raw := range r.Body["files"].([]any) {
			if raw.(map[string]any)["path"] == "big.bin" {
				return 409, map[string]any{"error": map[string]any{"code": "conflict", "message": "being committed",
					"details": map[string]any{"path": "big.bin", "reason": "committing", "uploadId": "u1"}}}
			}
		}
		return inner(r)
	}
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	if len(presigns) != 2 || len(presigns[1]["files"].([]any)) != 1 {
		t.Errorf("presigned twice, the second without big.bin: %v", presigns)
	}
	if fmt.Sprint(commits) != "[[u1 u2]]" || !strings.Contains(out, "2 uploaded") {
		t.Errorf("commits %v out %s", commits, out)
	}
}

func TestAssetSyncMultipartRepresignsALapsedPartURL(t *testing.T) {
	noSleep(t)
	t.Setenv("YYT_CACHE", t.TempDir())
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"big.bin": "0123456789"})
	var partReqs []map[string]any
	var commits [][]any
	routes := multipartRoutes(t, s3, nil, &partReqs, &commits)
	// The first URL of part 2 answers 403 (its signature lapsed); a fresh one works.
	s3.forbid = map[string]int{"/part/big.bin/2": 1}
	f := newFake(t, routes)
	if _, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--rate", "0"); err != nil {
		t.Fatal(err)
	}
	if len(partReqs) != 2 || fmt.Sprint(partReqs[1]["parts"]) != fmt.Sprintf("[map[partNumber:2 sha256:%s]]", shaOf("4567")) {
		t.Errorf("one fresh URL for part 2 only: %v", partReqs)
	}
	if s3.body["/part/big.bin/2"] != "4567" || fmt.Sprint(commits) != "[[u1]]" {
		t.Errorf("PUTs %v commits %v", s3.body, commits)
	}
}

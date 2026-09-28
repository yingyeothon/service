package cmd

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yingyeothon/service/cli/internal/assetcrypt"
)

// testKey is the shared non-secret vector key (docs/asset-encryption-vectors.json).
const testKeyText = "yak1.ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8"

func testKey(t *testing.T) assetcrypt.Key {
	t.Helper()
	k, err := assetcrypt.ParseKey(testKeyText)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func encryptedBundle(mode string) map[string]any {
	b := map[string]any{}
	for k, v := range liveBundle {
		b[k] = v
	}
	b["mode"] = mode
	b["encrypted"] = true
	return b
}

var keyRoute = func(recorded) (int, any) {
	return 200, map[string]any{"bundleId": "ab_1", "key": testKeyText, "format": "yyt-enc-v1"}
}

func TestAssetCreateEncrypted(t *testing.T) {
	withProject(t)
	var sent map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /projects/prj_1/assets/bundles": func(r recorded) (int, any) { sent = r.Body; return 201, encryptedBundle("live") },
	}, nil, nil, nil))
	out, _, err := run(t, f, "asset", "create", "content", "--mode", "live", "--encrypted")
	if err != nil {
		t.Fatal(err)
	}
	if sent["encrypted"] != true || !strings.Contains(out, "encrypted:   true") {
		t.Fatalf("sent %v, out %s", sent, out)
	}
	// Not sent by default: an older console's strict body refuses the key.
	if _, _, err := run(t, f, "asset", "create", "plain"); err != nil {
		t.Fatal(err)
	}
	if _, has := sent["encrypted"]; has {
		t.Fatalf("a plain create sent %v", sent)
	}
}

func TestAssetKeyShow(t *testing.T) {
	var reqs []recorded
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /assets/bundles/ab_1/key": func(r recorded) (int, any) { reqs = append(reqs, r); return keyRoute(r) },
	}, nil, nil, []any{encryptedBundle("live")}))
	out, stderr, err := run(t, f, "asset", "key", "show", "ab_1")
	if err != nil {
		t.Fatal(err)
	}
	if out != testKeyText+"\n" {
		t.Fatalf("stdout %q", out)
	}
	if !strings.Contains(stderr, "never commit it") {
		t.Fatalf("stderr %q", stderr)
	}
	if len(reqs) != 1 || reqs[0].Method != http.MethodPost {
		t.Fatalf("reqs %v", reqs)
	}
	out, _, err = run(t, f, "--json", "asset", "key", "show", "ab_1")
	if err != nil || !strings.Contains(out, `"key": "`+testKeyText+`"`) {
		t.Fatalf("json: %v %s", err, out)
	}
	// A key the console did not shape right is refused, not printed.
	f2 := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"POST /assets/bundles/ab_1/key": func(recorded) (int, any) {
			return 200, map[string]any{"bundleId": "ab_1", "key": "yak1.short"}
		},
	}, nil, nil, []any{encryptedBundle("live")}))
	if out, _, err := run(t, f2, "asset", "key", "show", "ab_1"); err == nil || out != "" {
		t.Fatalf("bad key: %v %q", err, out)
	}
}

func TestAssetSyncEncryptedSendsCiphertext(t *testing.T) {
	noSleep(t)
	cache := t.TempDir()
	t.Setenv("YYT_CACHE", cache)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{
		"data/songs.db": strings.Repeat("s", 70_000),
		"manifest.json": `{"v":1}`,
		"empty.bin":     "",
	})
	var presigns []map[string]any
	var commits [][]any
	var keyReads int
	routes := liveSyncRoutes(t, s3, nil, &presigns, &commits, nil)
	routes["GET /assets/bundles/ab_1"] = func(recorded) (int, any) { return 200, encryptedBundle("live") }
	routes["POST /assets/bundles/ab_1/key"] = func(r recorded) (int, any) { keyReads++; return keyRoute(r) }
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "done: 3 uploaded") {
		t.Fatalf("out %s", out)
	}
	if keyReads != 1 {
		t.Fatalf("key reads %d", keyReads)
	}
	// Immutable files first, then the manifest; every presign names the format.
	if len(presigns) != 2 || presigns[0]["format"] != assetEncFormat || presigns[1]["format"] != assetEncFormat {
		t.Fatalf("presigns %v", presigns)
	}
	key := testKey(t)
	for _, raw := range append(presigns[0]["files"].([]any), presigns[1]["files"].([]any)...) {
		spec := raw.(map[string]any)
		p := spec["path"].(string)
		body := s3.body["/put/"+p]
		plain, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
		if err != nil {
			t.Fatal(err)
		}
		want := assetcrypt.Encrypt(key, p, plain)
		if body != string(want) {
			t.Errorf("%s: PUT body is not the deterministic ciphertext (%d vs %d bytes)", p, len(body), len(want))
		}
		if int64(spec["size"].(float64)) != int64(len(want)) || spec["sha256"] != shaOf(string(want)) {
			t.Errorf("%s: spec %v", p, spec)
		}
		if got, err := assetcrypt.Decrypt(key, p, []byte(body)); err != nil || !bytes.Equal(got, plain) {
			t.Errorf("%s: decrypt %v", p, err)
		}
	}
	// The temporary ciphertext is gone; the digests stay (never the key).
	ents, _ := os.ReadDir(cache)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "enc-tmp-") {
			t.Errorf("temp dir left: %s", e.Name())
		}
	}
	digests, _ := os.ReadDir(filepath.Join(cache, "enc", "ab_1"))
	if len(digests) != 3 {
		t.Fatalf("digest entries %d", len(digests))
	}
	for _, d := range digests {
		b, _ := os.ReadFile(filepath.Join(cache, "enc", "ab_1", d.Name()))
		if strings.Contains(string(b), testKeyText[5:]) {
			t.Fatal("a digest entry carries the key")
		}
	}
	// A second run: every file is remembered, nothing is encrypted up front,
	// and a file the plan sends is encrypted at send time (the digest cache
	// answered the plan, the bytes are made when they are needed).
	presigns, commits = nil, nil
	s3.body = map[string]string{}
	out, _, err = run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--rate", "0")
	if err != nil || !strings.Contains(out, "done: 3 uploaded") {
		t.Fatalf("second run: %v %s", err, out)
	}
	if body := s3.body["/put/data/songs.db"]; !strings.HasPrefix(body, "\x28") {
		t.Fatalf("second run PUT %d bytes", len(body))
	}
	// A file that changed after the plan was made is refused, not sent
	// under a stale digest: simulate with a digest entry that lies.
	entry := filepath.Join(cache, "enc", "ab_1", digests[0].Name())
	b, _ := os.ReadFile(entry)
	var d encDigest
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	d.SHA256 = strings.Repeat("f", 64)
	b, _ = json.Marshal(d)
	_ = os.WriteFile(entry, b, 0o600)
	presigns = nil
	_, _, err = run(t, f, "asset", "sync", "ab_1", dir, "--mutable", "manifest.json", "--rate", "0")
	if err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("stale digest: %v", err)
	}
}

func TestAssetSyncEncryptedSkipsUnchangedCiphertext(t *testing.T) {
	noSleep(t)
	s3 := newS3Fake(t)
	dir := writeTree(t, map[string]string{"a.bin": "same"})
	key := testKey(t)
	ct := assetcrypt.Encrypt(key, "v2/a.bin", []byte("same"))
	remote := []any{liveFile("a.bin", shaOf(string(ct)), false, nil)}
	var presigns []map[string]any
	var commits [][]any
	routes := liveSyncRoutes(t, s3, remote, &presigns, &commits, nil)
	routes["GET /assets/bundles/ab_1"] = func(recorded) (int, any) { return 200, encryptedBundle("versioned") }
	routes["GET /assets/bundles/ab_1/files"] = func(r recorded) (int, any) {
		return 200, map[string]any{"files": remote, "next": nil}
	}
	routes["POST /assets/bundles/ab_1/key"] = keyRoute
	f := newFake(t, routes)
	out, _, err := run(t, f, "asset", "sync", "ab_1", dir, "--version", "v2", "--rate", "0")
	if err != nil {
		t.Fatal(err)
	}
	// The same bytes at the same path under the same key: nothing to send.
	if len(presigns) != 0 || !strings.Contains(out, "1 unchanged") {
		t.Fatalf("presigns %v out %s", presigns, out)
	}
}

func TestAssetUploadRefusesAnEncryptedBundle(t *testing.T) {
	dir := writeTree(t, map[string]string{"map.json": "{}"})
	f := newFake(t, map[string]func(recorded) (int, any){
		"POST /assets/bundles/ab_1/files": func(recorded) (int, any) {
			return 400, map[string]any{"error": map[string]any{"code": "bad_request", "message": `this bundle is encrypted: uploads carry format "yyt-enc-v1"`}}
		},
	})
	for _, args := range [][]string{
		{"asset", "upload", "ab_1", "v1", filepath.Join(dir, "map.json")},
		{"asset", "push", "ab_1", "v1", dir},
	} {
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), "yyt asset sync ab_1 <dir>") {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

// cdnServing serves one ciphertext with Range and If-Range (ServeContent).
func cdnServing(t *testing.T, ct []byte) (*httptest.Server, *int) {
	t.Helper()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("ETag", `"ct-1"`)
		http.ServeContent(w, r, "f.bin", time.Unix(0, 0), bytes.NewReader(ct))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestAssetDownloadEncrypted(t *testing.T) {
	noSleep(t)
	key := testKey(t)
	plain := []byte(strings.Repeat("0123456789", 7000)) // 70,000 bytes: two segments
	ct := assetcrypt.Encrypt(key, "v3/dir/f.bin", plain)
	cdn, hits := cdnServing(t, ct)
	routes := func(url string) map[string]func(recorded) (int, any) {
		return map[string]func(recorded) (int, any){
			"GET /assets/bundles/ab_1":      func(recorded) (int, any) { return 200, encryptedBundle("versioned") },
			"POST /assets/bundles/ab_1/key": keyRoute,
			"GET /assets/bundles/ab_1/files": func(r recorded) (int, any) {
				file := liveFile("dir/f.bin", shaOf(string(ct)), false, nil)
				file["version"] = "v3"
				file["url"] = url
				return 200, map[string]any{"files": []any{file}}
			},
		}
	}
	f := newFake(t, routes(cdn.URL+"/assets/ab_1/v3/dir/f.bin"))
	dst := filepath.Join(t.TempDir(), "out.bin")
	if _, stderr, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "-o", dst); err != nil {
		t.Fatal(err, stderr)
	} else if !strings.Contains(stderr, "decrypted") {
		t.Fatalf("stderr %q", stderr)
	}
	if b, _ := os.ReadFile(dst); !bytes.Equal(b, plain) {
		t.Fatalf("plaintext differs (%d bytes)", len(b))
	}
	// The header once, then the segments: two requests for a whole file.
	if *hits != 2 {
		t.Errorf("hits %d", *hits)
	}
	// A range across the segment boundary fetches both segments and slices.
	*hits = 0
	from, to := assetcrypt.FirstPlain-3, assetcrypt.FirstPlain+4
	out, _, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "--range", fmt.Sprintf("%d-%d", from, to), "-o", "-")
	if err != nil || out != string(plain[from:to+1]) {
		t.Fatalf("range: %v %q", err, out)
	}
	// A range inside the first segment fetches that segment only.
	out, _, err = run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "--range", "2-5", "-o", "-")
	if err != nil || out != "2345" {
		t.Fatalf("range: %v %q", err, out)
	}
	out, _, err = run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "--range", "69998-", "-o", "-")
	if err != nil || out != "89" {
		t.Fatalf("open range: %v %q", err, out)
	}
	if _, _, err := run(t, f, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "--range", "70000-", "-o", "-"); err == nil {
		t.Fatal("a range past the end must refuse")
	}
	// A flipped byte in the second segment: nothing is written, and the
	// error names the corruption, never the key.
	bad := append([]byte(nil), ct...)
	bad[assetcrypt.SegmentSize+10] ^= 1
	badCdn, _ := cdnServing(t, bad)
	f2 := newFake(t, routes(badCdn.URL+"/assets/ab_1/v3/dir/f.bin"))
	dst2 := filepath.Join(t.TempDir(), "bad.bin")
	_, _, err = run(t, f2, "asset", "download", "ab_1", "dir/f.bin", "--version", "v3", "-o", dst2)
	if err == nil || !strings.Contains(err.Error(), "asset_corrupt") || strings.Contains(err.Error(), testKeyText[5:]) {
		t.Fatalf("corrupt: %v", err)
	}
	if _, err := os.Stat(dst2); err == nil {
		t.Fatal("a corrupt download left a file")
	}
	if ents, _ := os.ReadDir(filepath.Dir(dst2)); len(ents) != 0 {
		t.Errorf("dir holds %d entries", len(ents))
	}
	// The wrong path (another AD) fails the same way.
	f3 := newFake(t, func() map[string]func(recorded) (int, any) {
		r := routes(cdn.URL + "/assets/ab_1/v3/dir/f.bin")
		r["GET /assets/bundles/ab_1/files"] = func(recorded) (int, any) {
			file := liveFile("dir/g.bin", shaOf(string(ct)), false, nil)
			file["version"] = "v3"
			file["url"] = cdn.URL + "/assets/ab_1/v3/dir/f.bin"
			return 200, map[string]any{"files": []any{file}}
		}
		return r
	}())
	if _, _, err := run(t, f3, "asset", "download", "ab_1", "dir/g.bin", "--version", "v3", "-o", "-"); err == nil || !strings.Contains(err.Error(), "asset_corrupt") {
		t.Fatalf("wrong path: %v", err)
	}
}

func TestAssetDownloadEncryptedEmptyFile(t *testing.T) {
	noSleep(t)
	key := testKey(t)
	ct := assetcrypt.Encrypt(key, "e.bin", nil)
	if hex.EncodeToString(ct[:1]) != "28" || len(ct) != assetcrypt.MinCiphertext {
		t.Fatal("fixture")
	}
	cdn, _ := cdnServing(t, ct)
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /assets/bundles/ab_1":      func(recorded) (int, any) { return 200, encryptedBundle("live") },
		"POST /assets/bundles/ab_1/key": keyRoute,
		"GET /assets/bundles/ab_1/files": func(recorded) (int, any) {
			file := liveFile("e.bin", shaOf(string(ct)), false, nil)
			file["url"] = cdn.URL + "/assets/ab_1/e.bin"
			return 200, map[string]any{"files": []any{file}}
		},
	})
	out, _, err := run(t, f, "asset", "download", "ab_1", "e.bin", "-o", "-")
	if err != nil || out != "" {
		t.Fatalf("empty: %v %q", err, out)
	}
}

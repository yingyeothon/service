package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func tarGz(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write(body)
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// fakeGitHub serves a release list plus one linux/amd64 archive for cli/v9.9.9.
func fakeGitHub(t *testing.T, sumsOK bool) (*Updater, []byte) {
	t.Helper()
	bin := []byte("#!/bin/sh\necho new\n")
	archive := tarGz(t, "yyt", bin)
	sum := sha256.Sum256(archive)
	hexSum := hex.EncodeToString(sum[:])
	if !sumsOK {
		hexSum = "deadbeef"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/releases", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"tag_name":"cli/v9.9.9-rc1","prerelease":true},{"tag_name":"cli/v10.0.0-rc1"},{"tag_name":"v2.0.0"},{"tag_name":"cli/v9.9.9"},{"tag_name":"cli/v9.10.0","draft":true},{"tag_name":"cli/v1.2.3"}]`)
	})
	mux.HandleFunc("/download/cli%2Fv9.9.9/yyt_9.9.9_linux_amd64.tar.gz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(archive) })
	mux.HandleFunc("/download/cli%2Fv9.9.9/checksums.txt", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%s  yyt_9.9.9_linux_amd64.tar.gz\n%s  yyt_9.9.9_darwin_arm64.tar.gz\n", hexSum, hexSum)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &Updater{ReleasesAPI: srv.URL + "/releases", DownloadBase: srv.URL + "/download/", HTTP: srv.Client(), OS: "linux", Arch: "amd64"}, bin
}

func TestLatestSkipsDraftsPrereleasesAndOtherTags(t *testing.T) {
	u, _ := fakeGitHub(t, true)
	rel, err := u.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rel.Tag != "cli/v9.9.9" || rel.Version != "9.9.9" {
		t.Fatalf("got %+v", rel)
	}
}

func TestDownloadVerifiesChecksum(t *testing.T) {
	u, want := fakeGitHub(t, true)
	got, err := u.Download(context.Background(), Release{Tag: "cli/v9.9.9", Version: "9.9.9"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("binary mismatch: %q", got)
	}
	bad, _ := fakeGitHub(t, false)
	if _, err := bad.Download(context.Background(), Release{Tag: "cli/v9.9.9", Version: "9.9.9"}); err == nil {
		t.Fatal("checksum mismatch must fail")
	}
	u.Arch = "arm64" // listed in checksums but no asset
	if _, err := u.Download(context.Background(), Release{Tag: "cli/v9.9.9", Version: "9.9.9"}); err == nil {
		t.Fatal("missing asset must fail")
	}
}

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0}, {"1.2.10", "1.2.9", 1}, {"v1.0.0", "1.0.0", 0},
		{"dev", "0.0.1", -1}, {"0.0.1", "dev", 1}, {"dev", "(devel)", 0}, {"v0.3.0", "0.3.1", -1},
	}
	for _, c := range cases {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestReplaceKeepsModeAndLeavesNoTemp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "yyt")
	if err := os.WriteFile(target, []byte("old"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := Replace(target, []byte("new")); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(target)
	st, _ := os.Stat(target)
	if string(b) != "new" || st.Mode().Perm() != 0o700 {
		t.Fatalf("content %q mode %v", b, st.Mode())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temp files left: %v", entries)
	}
	if err := Replace(filepath.Join(dir, "missing"), []byte("x")); err == nil {
		t.Fatal("missing target must fail")
	}
}

func TestParseRelease(t *testing.T) {
	if r, err := ParseRelease("v1.2.0"); err != nil || r.Tag != "cli/v1.2.0" || r.Version != "1.2.0" {
		t.Fatalf("%+v %v", r, err)
	}
	for _, bad := range []string{"", "1.2", "1.0.0?x=1", "1.0.0-rc1", "../x", "latest"} {
		if _, err := ParseRelease(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

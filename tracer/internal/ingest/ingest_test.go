package ingest

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/resource"
)

const testKey = "aaaaaaaaaaaaaaaaaaaa"

func localSource(t *testing.T) resource.Source {
	t.Helper()
	f, err := config.ParseLocal([]byte(`{"resources":[{"id":"trc_demo1","writeKey":"` + testKey + `"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return resource.NewLocal(f)
}

func testServer(t *testing.T, opt Options) (*httptest.Server, *metrics.Registry) {
	t.Helper()
	if opt.Source == nil {
		opt.Source = localSource(t)
	}
	if opt.Metrics == nil {
		opt.Metrics = metrics.New()
	}
	srv := httptest.NewServer(New(opt))
	t.Cleanup(srv.Close)
	return srv, opt.Metrics
}

func post(t *testing.T, url, body string, header map[string]string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestAuth(t *testing.T) {
	srv, reg := testServer(t, Options{})
	auth := map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey + ", sentry_version=7, sentry_client=yyt-dart/0.1.0"}
	cases := []struct {
		name   string
		url    string
		header map[string]string
		want   int
	}{
		{"no key", "/api/trc_demo1/envelope/", nil, http.StatusUnauthorized},
		{"wrong key", "/api/trc_demo1/envelope/?sentry_key=nope", nil, http.StatusUnauthorized},
		{"unknown resource", "/api/trc_other/envelope/", auth, http.StatusUnauthorized},
		{"numeric id", "/api/7/envelope/", auth, http.StatusUnauthorized},
		{"upper id", "/api/TRC_DEMO1/envelope/", auth, http.StatusUnauthorized},
		// Past auth P1 answers 501; P3 turns these into 200.
		{"header key", "/api/trc_demo1/envelope/", auth, http.StatusNotImplemented},
		{"query key", "/api/trc_demo1/envelope/?sentry_key=" + testKey, nil, http.StatusNotImplemented},
		{"legacy store", "/api/trc_demo1/store/", auth, http.StatusNotImplemented},
		{"subpath not routed", "/api/trc_demo1/envelope/x", auth, http.StatusNotFound},
	}
	for _, c := range cases {
		if got := post(t, srv.URL+c.url, "{}\n", c.header); got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
	if got := reg.Counters.Rejected401.Load(); got != 5 {
		t.Errorf("rejected401 = %d, want 5", got)
	}
}

type failingSource struct{}

func (failingSource) Lookup(context.Context, string) (resource.Resource, error) {
	return resource.Resource{}, errors.New("console down")
}

func TestSourceFailureIs503(t *testing.T) {
	srv, _ := testServer(t, Options{Source: failingSource{}})
	if got := post(t, srv.URL+"/api/trc_demo1/envelope/?sentry_key=x", "", nil); got != http.StatusServiceUnavailable {
		t.Fatalf("status %d", got)
	}
}

func TestDumpScrubsCredentials(t *testing.T) {
	dir := t.TempDir()
	srv, _ := testServer(t, Options{DumpDir: dir, MaxBodyBytes: 64})
	h := map[string]string{
		"X-Sentry-Auth":    "Sentry sentry_key=" + testKey + ", sentry_version=7, sentry_client=sentry.java.android.flutter/8.0.0",
		"Content-Encoding": "gzip",
	}
	if got := post(t, srv.URL+"/api/trc_demo1/envelope/?sentry_key="+testKey, "{\"event_id\":\"x\"}\n", h); got != http.StatusOK {
		t.Fatalf("status %d", got)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(files) != 2 {
		t.Fatalf("dump files %v", files)
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), testKey) {
			t.Errorf("%s contains the write key", filepath.Base(f))
		}
		if strings.HasSuffix(f, ".meta.json") && (!strings.Contains(string(b), "sentry.java.android.flutter/8.0.0") || !strings.Contains(string(b), "gzip")) {
			t.Errorf("meta lost the client header: %s", b)
		}
	}
	lower := map[string]string{"X-Sentry-Auth": "sentry sentry_key=" + testKey + ",sentry_secret=s3cret", "Proxy-Authorization": "Basic " + testKey}
	if got := post(t, srv.URL+"/api/trc_demo1/envelope/", "{}\n", lower); got != http.StatusOK {
		t.Fatalf("lowercase scheme: status %d", got)
	}
	files, _ = filepath.Glob(filepath.Join(dir, "*"))
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), testKey) || strings.Contains(string(b), "s3cret") {
			t.Errorf("%s contains a credential: %s", filepath.Base(f), b)
		}
	}
	if got := post(t, srv.URL+"/api/trc_demo1/envelope/?sentry_key="+testKey, strings.Repeat("x", 65), nil); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize dump: status %d", got)
	}
}

func TestSentryKeyForms(t *testing.T) {
	for header, want := range map[string]string{
		"Sentry sentry_key=abc, sentry_version=7": "abc",
		"sentry sentry_version=7,sentry_key=def":  "def",
		"Sentry sentry_version=7":                 "",
		"SENTRY\tsentry_key=ghi":                  "ghi",
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Header.Set("X-Sentry-Auth", header)
		if got := SentryKey(r); got != want {
			t.Errorf("%q: %q, want %q", header, got, want)
		}
	}
}

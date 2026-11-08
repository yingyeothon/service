package ingest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yingyeothon/service/tracer/internal/config"
)

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg, err := config.Parse([]byte(`{"listen":"127.0.0.1:0","db":"x.db","projects":[{"id":7,"slug":"demo","key":"abc"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(cfg))
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, url string, header map[string]string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader("{}\n"))
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

func TestHealth(t *testing.T) {
	srv := testServer(t)
	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestAuth(t *testing.T) {
	srv := testServer(t)
	auth := map[string]string{"X-Sentry-Auth": "Sentry sentry_key=abc, sentry_version=7, sentry_client=sentry.dart/9.0.0"}
	cases := []struct {
		name   string
		url    string
		header map[string]string
		want   int
	}{
		{"no key", "/api/7/envelope/", nil, http.StatusUnauthorized},
		{"wrong key", "/api/7/envelope/?sentry_key=nope", nil, http.StatusUnauthorized},
		{"unknown project", "/api/8/envelope/", auth, http.StatusUnauthorized},
		{"non-numeric project", "/api/demo/envelope/", auth, http.StatusUnauthorized},
		// Past auth the phase-0 skeleton answers 501; phase 1 turns these into 200.
		{"header key", "/api/7/envelope/", auth, http.StatusNotImplemented},
		{"query key", "/api/7/envelope/?sentry_key=abc", nil, http.StatusNotImplemented},
		{"legacy store", "/api/7/store/", auth, http.StatusNotImplemented},
		{"subpath not routed", "/api/7/envelope/x", auth, http.StatusNotFound},
	}
	for _, c := range cases {
		if got := post(t, srv.URL+c.url, c.header); got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
}

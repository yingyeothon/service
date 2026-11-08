package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yingyeothon/service/tracer/internal/metrics"
)

type probe struct{ err error }

func (p probe) Writable(context.Context) error { return p.err }

func get(t *testing.T, url, bearer string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestLivezHealthz(t *testing.T) {
	ok := httptest.NewServer(New(Options{DB: probe{}, Metrics: metrics.New()}))
	defer ok.Close()
	if code, _ := get(t, ok.URL+"/livez", ""); code != 200 {
		t.Errorf("livez %d", code)
	}
	if code, _ := get(t, ok.URL+"/healthz", ""); code != 200 {
		t.Errorf("healthz %d", code)
	}
	bad := httptest.NewServer(New(Options{DB: probe{errors.New("ro")}, Metrics: metrics.New()}))
	defer bad.Close()
	if code, _ := get(t, bad.URL+"/livez", ""); code != 503 {
		t.Errorf("livez on unwritable DB %d", code)
	}
	notReady := httptest.NewServer(New(Options{DB: probe{}, Metrics: metrics.New(),
		Ready: func(context.Context) (string, bool) { return "down", false }}))
	defer notReady.Close()
	if code, body := get(t, notReady.URL+"/healthz", ""); code != 503 || !strings.Contains(body, `"console":"down"`) {
		t.Errorf("healthz not ready %d %s", code, body)
	}
	if code, _ := get(t, notReady.URL+"/livez", ""); code != 200 {
		t.Errorf("livez must not follow console readiness: %d", code)
	}
}

func TestMetricsDetailNeedsBearer(t *testing.T) {
	reg := metrics.New()
	reg.Resource("trc_hidden").Accepted.Add(1)
	token := strings.Repeat("k", 32)
	srv := httptest.NewServer(New(Options{DB: probe{}, Metrics: reg, Detail: reg.Detailed, OperatorToken: token}))
	defer srv.Close()
	for _, bearer := range []string{"", "wrong", token + "x"} {
		if _, body := get(t, srv.URL+"/metrics", bearer); strings.Contains(body, "trc_hidden") {
			t.Errorf("bearer %q saw resource ids", bearer)
		}
	}
	if _, body := get(t, srv.URL+"/metrics", token); !strings.Contains(body, "trc_hidden") {
		t.Errorf("operator missed resource ids: %s", body)
	}
	local := httptest.NewServer(New(Options{DB: probe{}, Metrics: reg, Detail: reg.Detailed}))
	defer local.Close()
	if _, body := get(t, local.URL+"/metrics", ""); strings.Contains(body, "trc_hidden") {
		t.Error("no operator token must mean no detail")
	}
}

func TestComposition(t *testing.T) {
	ingest := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) })
	read := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(298) })
	srv := httptest.NewServer(New(Options{DB: probe{}, Metrics: metrics.New(), Ingest: ingest, Read: read}))
	defer srv.Close()
	for path, want := range map[string]int{"/api/trc_a/envelope/": 299, "/v1/trc_a/events": 298, "/other": 404} {
		if code, _ := get(t, srv.URL+path, ""); code != want {
			t.Errorf("%s: %d, want %d", path, code, want)
		}
	}
	bare := httptest.NewServer(New(Options{DB: probe{}, Metrics: metrics.New()}))
	defer bare.Close()
	if code, _ := get(t, bare.URL+"/v1/trc_a/events", ""); code != 404 {
		t.Errorf("no read mux: %d", code)
	}
}

type countingProbe struct{ n atomic.Int64 }

func (p *countingProbe) Writable(context.Context) error { p.n.Add(1); return nil }

func TestLivezSharesOneWriteProbe(t *testing.T) {
	p := &countingProbe{}
	srv := httptest.NewServer(New(Options{DB: p, Metrics: metrics.New()}))
	defer srv.Close()
	for range 20 {
		get(t, srv.URL+"/livez", "")
	}
	get(t, srv.URL+"/healthz", "")
	if n := p.n.Load(); n != 1 {
		t.Fatalf("a public poller made %d DB writes", n)
	}
}

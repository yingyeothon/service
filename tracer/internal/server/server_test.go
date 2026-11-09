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

	"github.com/yingyeothon/service/tracer/internal/addrlimit"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/query"
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

type ctxProbe struct{}

func (ctxProbe) Writable(ctx context.Context) error { return ctx.Err() }

func TestLivezProbeIgnoresCallerCancel(t *testing.T) {
	s := New(Options{DB: ctxProbe{}, Metrics: metrics.New()})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.writable(ctx); err != nil {
		t.Fatalf("a cancelled caller was cached as unwritable: %v", err)
	}
}

func corsReq(t *testing.T, method, url, origin string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func TestReadCORS(t *testing.T) {
	const spa = "https://console-dev.example.com"
	var reads atomic.Int64
	// The read handler stands in for every answer it gives, a limiter 503
	// with its Retry-After included: CORS headers are set before it runs.
	read := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		switch r.URL.Path {
		case "/v1/trc_a/events":
			w.Header().Set("X-Tracer-Sha256", "x")
			w.WriteHeader(200)
		case "/v1/trc_a/limited":
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(503)
		default:
			w.WriteHeader(401)
		}
	})
	ingest := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	reg := metrics.New()
	srv := httptest.NewServer(New(Options{DB: probe{}, Metrics: reg, Detail: reg.Detailed, Ingest: ingest, Read: read,
		OperatorToken: strings.Repeat("t", 32), UsageDB: nil, ReadOrigins: []string{spa, "http://127.0.0.1:5173"}}))
	defer srv.Close()

	for path, code := range map[string]int{"/v1/trc_a/events": 200, "/v1/trc_a/limited": 503, "/v1/trc_a/nope": 401} {
		res := corsReq(t, "GET", srv.URL+path, spa)
		h := res.Header
		if res.StatusCode != code || h.Get("Access-Control-Allow-Origin") != spa ||
			h.Get("Access-Control-Expose-Headers") != "Retry-After, X-Tracer-Sha256" ||
			len(h.Values("Vary")) != 1 || h.Get("Vary") != "Origin" || h.Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("%s: %d %v", path, res.StatusCode, h)
		}
	}
	// Another origin, or none: no CORS headers, Vary still set.
	for _, origin := range []string{"https://evil.example.com", "null", "", spa + "/"} {
		res := corsReq(t, "GET", srv.URL+"/v1/trc_a/events", origin)
		if res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Access-Control-Expose-Headers") != "" ||
			res.Header.Get("Vary") != "Origin" {
			t.Errorf("origin %q: %v", origin, res.Header)
		}
	}
	// Preflight: 204 before the read handler (no limiter, no authz).
	before := reads.Load()
	res := corsReq(t, "OPTIONS", srv.URL+"/v1/trc_a/events", spa)
	h := res.Header
	if res.StatusCode != 204 || h.Get("Access-Control-Allow-Origin") != spa || h.Get("Access-Control-Allow-Methods") != "GET" ||
		h.Get("Access-Control-Allow-Headers") != "Authorization" || h.Get("Access-Control-Max-Age") != "600" {
		t.Errorf("preflight: %d %v", res.StatusCode, h)
	}
	res = corsReq(t, "OPTIONS", srv.URL+"/v1/trc_a/events", "https://evil.example.com")
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Access-Control-Allow-Methods") != "" {
		t.Errorf("foreign preflight: %d %v", res.StatusCode, res.Header)
	}
	if reads.Load() != before {
		t.Error("a preflight reached the read handler")
	}
	// Every other route but ingest (TestIngestCORS) stays without CORS.
	for _, path := range []string{"/livez", "/healthz", "/metrics", "/tr/usage", "/other"} {
		for _, method := range []string{"GET", "OPTIONS"} {
			res := corsReq(t, method, srv.URL+path, spa)
			if res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Access-Control-Allow-Methods") != "" {
				t.Errorf("%s %s carries CORS: %v", method, path, res.Header)
			}
		}
	}
}

type refuseAll struct{}

func (refuseAll) Authorize(context.Context, string, string) error { return query.ErrUnauthenticated }

// The real read handler behind the wrapper: its 401s, its 404 catch-all and
// the address limiter's 503 all stay readable by the SPA.
func TestReadCORSWrapsTheRealReadHandler(t *testing.T) {
	const spa = "https://console-dev.example.com"
	read := query.New(query.Options{Auth: refuseAll{}})
	srv := httptest.NewServer(New(Options{DB: probe{}, Metrics: metrics.New(), Read: read, ReadOrigins: []string{spa}}))
	defer srv.Close()
	ticket := "trr_" + strings.Repeat("0123456789abcdef", 3)
	do := func(path string) *http.Response {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		req.Header.Set("Origin", spa)
		req.Header.Set("Authorization", "Bearer "+ticket)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	if res := do("/v1/trc_a/nothing"); res.StatusCode != 404 || res.Header.Get("Access-Control-Allow-Origin") != spa {
		t.Fatalf("catch-all: %d %v", res.StatusCode, res.Header)
	}
	var last *http.Response
	for range addrlimit.Burst + 1 {
		last = do("/v1/trc_a/events")
	}
	if last.StatusCode != 503 || last.Header.Get("Retry-After") == "" || last.Header.Get("Access-Control-Allow-Origin") != spa ||
		!strings.Contains(last.Header.Get("Access-Control-Expose-Headers"), "Retry-After") {
		t.Fatalf("limiter: %d %v", last.StatusCode, last.Header)
	}
}

func TestIngestCORS(t *testing.T) {
	var posts atomic.Int64
	ingest := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		if strings.Contains(r.URL.Path, "limited") {
			w.Header().Set("Retry-After", "300")
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(401)
	})
	reg := metrics.New()
	srv := httptest.NewServer(New(Options{DB: probe{}, Metrics: reg, Detail: reg.Detailed, Ingest: ingest}))
	defer srv.Close()
	for path, code := range map[string]int{"/api/trc_a/envelope/": 401, "/api/trc_limited/envelope/": 429} {
		for _, origin := range []string{"https://game.example.com", "null", ""} {
			res := corsReq(t, "POST", srv.URL+path, origin)
			h := res.Header
			if res.StatusCode != code || h.Get("Access-Control-Allow-Origin") != "*" ||
				h.Get("Access-Control-Expose-Headers") != "Retry-After" || h.Get("Access-Control-Allow-Credentials") != "" {
				t.Errorf("%s from %q: %d %v", path, origin, res.StatusCode, h)
			}
		}
	}
	before := posts.Load()
	res := corsReq(t, "OPTIONS", srv.URL+"/api/trc_a/envelope/", "https://game.example.com")
	h := res.Header
	if res.StatusCode != 204 || h.Get("Access-Control-Allow-Origin") != "*" || h.Get("Access-Control-Allow-Methods") != "POST" ||
		h.Get("Access-Control-Allow-Headers") != "Content-Type, Content-Encoding, X-Sentry-Auth" ||
		h.Get("Access-Control-Max-Age") != "600" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Errorf("preflight: %d %v", res.StatusCode, h)
	}
	if posts.Load() != before {
		t.Error("a preflight reached the ingest handler")
	}
}

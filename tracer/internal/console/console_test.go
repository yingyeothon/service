package console

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/query"
	"github.com/yingyeothon/service/tracer/internal/resource"
)

// The fake console answers with the bodies the console's own route tests pin
// (services/console/test/tracer-internal.test.ts, src/tracer-internal.ts): a
// shape change there edits this file in the same commit.

const (
	token   = "trt_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	resID   = "trc_01jc0000000000000000000000"
	goneID  = "trc_01jc0000000000000000000001"
	readTok = "yyt_0123456789abcdef0123456789abcdef0123456789abcdef"
	// A console read ticket (decisions #12): same length, `trr_` prefix.
	ticket   = "trr_0123456789abcdef0123456789abcdef0123456789abcdef"
	badTok   = "yyt_ffffffffffffffffffffffffffffffffffffffffffffffff"
	stranger = "yyt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	writeKey = "wk_0123456789abcdef"
)

type fake struct {
	srv      *httptest.Server
	down     atomic.Bool
	status   atomic.Int32 // non-zero: answer every authenticated route with it
	calls    atomic.Int64
	health   atomic.Value // map[string]any
	deleted  atomic.Value // []string
	delay    time.Duration
	lastAuth atomic.Value
}

func newFake(t *testing.T) *fake {
	f := &fake{}
	f.health.Store(map[string]any{"service": "yyt-console", "tracer": true, "configured": true})
	f.deleted.Store([]string{goneID})
	sum := sha256.Sum256([]byte(writeKey))
	mux := http.NewServeMux()
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		f.calls.Add(1)
		f.lastAuth.Store(r.Header.Get("Authorization"))
		if f.delay > 0 {
			time.Sleep(f.delay)
		}
		if s := f.status.Load(); s != 0 {
			w.WriteHeader(int(s))
			return false
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("GET /tr/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(f.health.Load())
	})
	mux.HandleFunc("GET /tr/resources/deleted", func(w http.ResponseWriter, r *http.Request) {
		if auth(w, r) {
			json.NewEncoder(w).Encode(map[string]any{"ids": f.deleted.Load()})
		}
	})
	mux.HandleFunc("GET /tr/resources/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		if r.PathValue("id") != resID {
			json.NewEncoder(w).Encode(map[string]any{"teamId": nil, "projectId": nil, "writeKeySha256": nil, "state": "deleted", "dailyBytes": 0})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"teamId": "team_1", "projectId": "prj_1",
			"writeKeySha256": hex.EncodeToString(sum[:]), "state": "active", "dailyBytes": 52428800})
	})
	mux.HandleFunc("POST /tr/authz", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		// The console's body schema is strict (tracerAuthzBody `.strict()`).
		var b struct {
			Token      string `json:"token"`
			ResourceID string `json:"resourceId"`
		}
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&b); err != nil || b.Token == "" || b.ResourceID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch {
		case b.Token == badTok:
			json.NewEncoder(w).Encode(map[string]any{"allowed": false, "reason": "unknown_token"})
		case (b.Token == readTok || b.Token == ticket) && b.ResourceID == resID:
			json.NewEncoder(w).Encode(map[string]any{"allowed": true, "memberId": "usr_1"})
		default:
			json.NewEncoder(w).Encode(map[string]any{"allowed": false, "reason": "denied"})
		}
	})
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.down.Load() {
			hj, ok := w.(http.Hijacker)
			if ok {
				c, _, _ := hj.Hijack()
				c.Close()
				return
			}
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newClient(t *testing.T, f *fake, opt Options) (*Client, *clock, *metrics.Registry) {
	t.Helper()
	ck := &clock{t: time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)}
	reg := metrics.New()
	opt.BaseURL, opt.Token, opt.Now, opt.Metrics = f.srv.URL, token, ck.now, reg
	opt.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	if opt.Timeout == 0 {
		opt.Timeout = time.Second
	}
	c, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	return c, ck, reg
}

var ctx = context.Background()

func TestLookupActiveAndCache(t *testing.T) {
	f := newFake(t)
	c, ck, reg := newClient(t, f, Options{})
	r, err := c.Lookup(ctx, resID)
	if err != nil || !r.Active() || !r.KeyMatches(writeKey) || r.KeyMatches("other") || r.DailyBytes != 52428800 {
		t.Fatalf("lookup %+v %v", r, err)
	}
	if got := f.lastAuth.Load(); got != "Bearer "+token {
		t.Fatalf("bearer %v", got)
	}
	c.Lookup(ctx, resID)
	if f.calls.Load() != 1 {
		t.Fatalf("not cached: %d calls", f.calls.Load())
	}
	ck.add(61 * time.Second)
	c.Lookup(ctx, resID)
	if f.calls.Load() != 2 || reg.Counters.ConfigFetches.Load() != 2 {
		t.Fatalf("not refreshed after ttl: %d", f.calls.Load())
	}
}

func TestLookupDeletedIsNotFoundAndCached(t *testing.T) {
	f := newFake(t)
	c, _, _ := newClient(t, f, Options{})
	for range 3 {
		if _, err := c.Lookup(ctx, goneID); !errors.Is(err, resource.ErrNotFound) {
			t.Fatalf("deleted: %v", err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatalf("a deleted answer must be cached too: %d calls", f.calls.Load())
	}
	if _, err := c.Lookup(ctx, "not-an-id"); !errors.Is(err, resource.ErrNotFound) || f.calls.Load() != 1 {
		t.Fatalf("malformed id must not reach the console: %v", err)
	}
}

func TestLookupStaleWhileDown(t *testing.T) {
	f := newFake(t)
	c, ck, reg := newClient(t, f, Options{})
	if _, err := c.Lookup(ctx, resID); err != nil {
		t.Fatal(err)
	}
	for name, breakIt := range map[string]func(){
		"unreachable": func() { f.down.Store(true) },
		// Token rotation window: a 401 is an outage, never "not found".
		"401": func() { f.status.Store(http.StatusUnauthorized) },
		"502": func() { f.status.Store(http.StatusBadGateway) },
	} {
		f.down.Store(false)
		f.status.Store(0)
		breakIt()
		ck.add(2 * time.Minute)
		r, err := c.Lookup(ctx, resID)
		if err != nil || !r.Active() {
			t.Fatalf("%s: stale entry not served: %v", name, err)
		}
	}
	if reg.Counters.ConfigStale.Load() != 3 {
		t.Fatalf("stale counter %d", reg.Counters.ConfigStale.Load())
	}
	ck.add(25 * time.Hour)
	_, err := c.Lookup(ctx, resID)
	if err == nil || errors.Is(err, resource.ErrNotFound) || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("past the stale window the answer is unavailable (503), never not-found (401): %v", err)
	}
	// An unknown id while down is unavailable as well.
	if _, err := c.Lookup(ctx, goneID); errors.Is(err, resource.ErrNotFound) || err == nil {
		t.Fatalf("unknown id while down: %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Fatal("error carries the token")
	}
}

func TestLookupSingleflight(t *testing.T) {
	f := newFake(t)
	f.delay = 50 * time.Millisecond
	c, _, _ := newClient(t, f, Options{})
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Lookup(ctx, resID); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if f.calls.Load() != 1 {
		t.Fatalf("concurrent lookups made %d calls", f.calls.Load())
	}
}

func TestLookupCallerCancelDoesNotFailOthers(t *testing.T) {
	f := newFake(t)
	f.delay = 100 * time.Millisecond
	c, _, _ := newClient(t, f, Options{})
	short, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.Lookup(ctx, resID); done <- err }()
	time.Sleep(5 * time.Millisecond)
	if _, err := c.Lookup(short, resID); err == nil {
		t.Fatal("short caller should give up")
	}
	if err := <-done; err != nil {
		t.Fatalf("patient caller failed: %v", err)
	}
}

func TestBadConfigAnswersAreUnavailable(t *testing.T) {
	for name, body := range map[string]string{
		"state":   `{"state":"frozen","writeKeySha256":"00","dailyBytes":1}`,
		"digest":  `{"state":"active","writeKeySha256":"zz","dailyBytes":1}`,
		"no key":  `{"state":"active","writeKeySha256":null,"dailyBytes":1}`,
		"quota":   `{"state":"active","writeKeySha256":"` + strings.Repeat("0", 64) + `","dailyBytes":0}`,
		"garbage": `<html>`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
		c, err := New(Options{BaseURL: srv.URL, Token: token, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Lookup(ctx, resID); !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s: %v", name, err)
		}
		srv.Close()
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	var hit atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit.Store(true) }))
	defer other.Close()
	srv := httptest.NewServer(http.RedirectHandler(other.URL+"/x", http.StatusFound))
	defer srv.Close()
	c, _ := New(Options{BaseURL: srv.URL, Token: token, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if _, err := c.Lookup(ctx, resID); !errors.Is(err, ErrUnavailable) || hit.Load() {
		t.Fatalf("redirect followed: %v hit=%v", err, hit.Load())
	}
}

func TestAuthorize(t *testing.T) {
	f := newFake(t)
	c, ck, reg := newClient(t, f, Options{})
	if err := c.Authorize(ctx, readTok, resID); err != nil {
		t.Fatalf("allowed: %v", err)
	}
	if err := c.Authorize(ctx, badTok, resID); !errors.Is(err, query.ErrUnauthenticated) {
		t.Fatalf("unknown token: %v", err)
	}
	if err := c.Authorize(ctx, stranger, resID); !errors.Is(err, query.ErrForbidden) {
		t.Fatalf("denied: %v", err)
	}
	if err := c.Authorize(ctx, readTok, goneID); !errors.Is(err, query.ErrForbidden) {
		t.Fatalf("other resource: %v", err)
	}
	calls := f.calls.Load()
	// Verdicts, refusals included, are cached for 60 s.
	c.Authorize(ctx, readTok, resID)
	c.Authorize(ctx, badTok, resID)
	c.Authorize(ctx, stranger, resID)
	if f.calls.Load() != calls || reg.Counters.AuthzCacheHits.Load() != 3 {
		t.Fatalf("verdicts not cached: %d → %d", calls, f.calls.Load())
	}
	// Malformed tokens never reach the console.
	if err := c.Authorize(ctx, "yyt_short", resID); !errors.Is(err, query.ErrUnauthenticated) || f.calls.Load() != calls {
		t.Fatalf("malformed token: %v", err)
	}
	// Reads fail closed: past the ttl with the console down, no stale verdict.
	ck.add(61 * time.Second)
	f.down.Store(true)
	err := c.Authorize(ctx, readTok, resID)
	if !errors.Is(err, query.ErrUnavailable) || errors.Is(err, query.ErrUnauthenticated) || errors.Is(err, query.ErrForbidden) {
		t.Fatalf("down: %v", err)
	}
	if strings.Contains(err.Error(), readTok) || strings.Contains(err.Error(), token) {
		t.Fatal("error carries a token")
	}
}

func TestAuthorizeUnknownReasonIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"allowed":false,"reason":"maintenance"}`)
	}))
	defer srv.Close()
	c, _ := New(Options{BaseURL: srv.URL, Token: token, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := c.Authorize(ctx, readTok, resID); !errors.Is(err, query.ErrUnavailable) {
		t.Fatalf("%v", err)
	}
}

func TestVerdictCacheBounded(t *testing.T) {
	f := newFake(t)
	c, _, _ := newClient(t, f, Options{MaxVerdict: 4})
	for i := range 10 {
		tok := "yyt_" + strings.Repeat("0", 46) + string(rune('a'+i)) + "0"
		c.Authorize(ctx, tok, resID)
	}
	c.mu.Lock()
	n := len(c.verdicts)
	c.mu.Unlock()
	if n > 4 {
		t.Fatalf("verdict cache grew to %d", n)
	}
}

func TestConfigCacheBounded(t *testing.T) {
	f := newFake(t)
	c, _, _ := newClient(t, f, Options{MaxConfigs: 3})
	for i := range 6 {
		c.Lookup(ctx, "trc_x"+string(rune('a'+i)))
	}
	c.Lookup(ctx, resID)
	c.mu.Lock()
	n := len(c.configs)
	_, kept := c.configs[resID]
	c.mu.Unlock()
	if n > 3 || !kept {
		t.Fatalf("config cache %d, newest kept %v", n, kept)
	}
	c.Forget(resID)
	c.mu.Lock()
	_, kept = c.configs[resID]
	c.mu.Unlock()
	if kept {
		t.Fatal("Forget kept the entry")
	}
}

func TestHealthAndDeleted(t *testing.T) {
	f := newFake(t)
	c, ck, _ := newClient(t, f, Options{})
	if s, ok := c.Health(ctx); !ok || s != "ok" {
		t.Fatalf("health %s", s)
	}
	ids, err := c.DeletedIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != goneID {
		t.Fatalf("deleted %v %v", ids, err)
	}
	for name, body := range map[string]map[string]any{
		"not configured": {"service": "yyt-console", "tracer": true, "configured": false},
		"wrong service":  {"service": "something-else", "tracer": true, "configured": true},
	} {
		f.health.Store(body)
		ck.add(HealthTTL)
		if _, ok := c.Health(ctx); ok {
			t.Errorf("%s: healthy", name)
		}
		if ids, err := c.DeletedIDs(ctx); err == nil || ids != nil {
			t.Errorf("%s: purge list served: %v", name, ids)
		}
	}
	f.health.Store(map[string]any{"service": "yyt-console", "tracer": true, "configured": true})
	f.deleted.Store([]string{goneID, "../etc"})
	if _, err := c.DeletedIDs(ctx); err == nil {
		t.Fatal("malformed id accepted")
	}
	f.down.Store(true)
	ck.add(HealthTTL)
	if s, ok := c.Health(ctx); ok || s != "unreachable" {
		t.Fatalf("down health %s", s)
	}
}

func TestHealthIsCachedAndShared(t *testing.T) {
	f := newFake(t)
	var hits atomic.Int64
	inner := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/tr/health" {
			hits.Add(1)
		}
		inner.ServeHTTP(w, r)
	})
	c, ck, _ := newClient(t, f, Options{})
	for range 5 {
		c.Health(ctx)
	}
	if hits.Load() != 1 {
		t.Fatalf("a public poller made %d console calls", hits.Load())
	}
	ck.add(HealthTTL)
	c.Health(ctx)
	if hits.Load() != 2 {
		t.Fatalf("not refreshed after ttl: %d", hits.Load())
	}
	// The purge never trusts the cached answer.
	c.DeletedIDs(ctx)
	if hits.Load() != 3 {
		t.Fatalf("purge used a cached health: %d", hits.Load())
	}
}

func TestMissingIDsDoNotEvictConfigs(t *testing.T) {
	f := newFake(t)
	c, ck, _ := newClient(t, f, Options{MaxConfigs: 2})
	c.Lookup(ctx, resID)
	for i := range 10 {
		c.Lookup(ctx, fmt.Sprintf("trc_guess%d", i))
	}
	// Console down past the ttl: the real resource still has its stale fallback.
	f.down.Store(true)
	ck.add(2 * time.Minute)
	if r, err := c.Lookup(ctx, resID); err != nil || !r.Active() {
		t.Fatalf("guesses evicted the real config: %v", err)
	}
	c.mu.Lock()
	n := len(c.missing)
	c.mu.Unlock()
	if n > 2 {
		t.Fatalf("missing set grew to %d", n)
	}
}

func TestAuthorizeReadTicket(t *testing.T) {
	f := newFake(t)
	c, _, _ := newClient(t, f, Options{})
	if err := c.Authorize(ctx, ticket, resID); err != nil {
		t.Fatalf("allowed: %v", err)
	}
	if err := c.Authorize(ctx, ticket, goneID); !errors.Is(err, query.ErrForbidden) {
		t.Fatalf("another resource: %v", err)
	}
	calls := f.calls.Load()
	for _, bad := range []string{"trr_short", "TRR_" + ticket[4:], "trr_" + ticket[4:] + "0"} {
		if err := c.Authorize(ctx, bad, resID); !errors.Is(err, query.ErrUnauthenticated) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if f.calls.Load() != calls {
		t.Fatal("a malformed ticket reached the console")
	}
}

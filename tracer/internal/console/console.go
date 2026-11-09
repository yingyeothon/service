// Package console is tracer's client of the console's internal `/tr/*`
// routes (docs/tracer.md _Principals_, todo/85 P5). It is the server-mode
// resource.Source (`GET /tr/resources/{id}`), query.Authorizer
// (`POST /tr/authz`), readiness probe (`GET /tr/health`) and the source of
// purgeable ids (`GET /tr/resources/deleted`). The bearer is the stage's
// `tracer-token`; it is never logged and never part of an error.
//
// Failure model: resource config is cached 60 s with singleflight and served
// stale for up to 24 h while the console is unreachable (ingest survives a
// console redeploy); a 401 from the console is an outage (token rotation
// window), never "not found". Read authorization fails closed: no stale
// verdicts, an outage is query.ErrUnavailable (503).
package console

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/query"
	"github.com/yingyeothon/service/tracer/internal/resource"
)

// Defaults.
const (
	DefaultTTL        = 60 * time.Second
	DefaultStaleFor   = 24 * time.Hour
	DefaultTimeout    = 3 * time.Second
	DefaultMaxConfigs = 4096
	DefaultMaxVerdict = 8192
	// maxBody bounds a console answer; the deleted list (≤ 1000 ids) is the largest.
	maxBody = 256 << 10
	// MaxDeletedIDs mirrors the console's page (TRACER_BATCH_MAX).
	MaxDeletedIDs = 1000
)

// ErrUnavailable is a console that did not give a usable answer.
var ErrUnavailable = errors.New("console: unavailable")

// Options configures a Client.
type Options struct {
	// BaseURL is the console API origin (config.Config.ConsoleURL).
	BaseURL string
	// Token is the `tracer-token`.
	Token      string
	HTTP       *http.Client
	Now        func() time.Time
	Metrics    *metrics.Registry
	Log        *slog.Logger
	TTL        time.Duration
	StaleFor   time.Duration
	Timeout    time.Duration
	MaxConfigs int
	MaxVerdict int
}

// Client talks to one console.
type Client struct {
	opt  Options
	base *url.URL

	mu      sync.Mutex
	configs map[string]*configEntry
	// missing holds "deleted" answers apart from configs, so made-up ids
	// never evict a real resource's stale fallback.
	missing  map[string]time.Time
	health   healthResult
	verdicts map[[32]byte]verdict
	calls    map[string]*call
}

type configEntry struct {
	res      resource.Resource
	notFound bool
	at       time.Time
}

type healthResult struct {
	state string
	ok    bool
	at    time.Time
}

// HealthTTL: `/healthz` is public, so its console probe is cached and shared
// (a poller must not turn it into one console call per hit).
const HealthTTL = 15 * time.Second

type verdict struct {
	err error // nil, query.ErrUnauthenticated or query.ErrForbidden
	at  time.Time
}

type call struct {
	done chan struct{}
	val  any
	err  error
}

// New builds a Client. The URL was validated by config.
func New(opt Options) (*Client, error) {
	u, err := url.Parse(opt.BaseURL)
	if err != nil || u.Host == "" {
		return nil, errors.New("console: bad base URL")
	}
	if opt.Token == "" {
		return nil, errors.New("console: token required")
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Metrics == nil {
		opt.Metrics = metrics.New()
	}
	if opt.Log == nil {
		opt.Log = slog.Default()
	}
	if opt.TTL <= 0 {
		opt.TTL = DefaultTTL
	}
	if opt.StaleFor <= 0 {
		opt.StaleFor = DefaultStaleFor
	}
	if opt.Timeout <= 0 {
		opt.Timeout = DefaultTimeout
	}
	if opt.MaxConfigs <= 0 {
		opt.MaxConfigs = DefaultMaxConfigs
	}
	if opt.MaxVerdict <= 0 {
		opt.MaxVerdict = DefaultMaxVerdict
	}
	if opt.HTTP == nil {
		opt.HTTP = &http.Client{
			// A redirect would carry the bearer elsewhere.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return &Client{opt: opt, base: u, configs: map[string]*configEntry{}, missing: map[string]time.Time{}, verdicts: map[[32]byte]verdict{},
		calls: map[string]*call{}}, nil
}

// ---- transport ----

// do sends one request with the bearer and decodes a 200 JSON answer into
// out. Every other outcome is ErrUnavailable wrapped with the status only.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, c.opt.Timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.JoinPath(path).String(), rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.opt.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.opt.HTTP.Do(req)
	if err != nil {
		// url.Error names the URL (no token); keep only the kind.
		return fmt.Errorf("%w: %s", ErrUnavailable, errKind(err))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, maxBody))
		return fmt.Errorf("%w: status %d", ErrUnavailable, res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("%w: %s", ErrUnavailable, errKind(err))
	}
	if len(b) > maxBody {
		return fmt.Errorf("%w: answer too large", ErrUnavailable)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%w: malformed answer", ErrUnavailable)
	}
	return nil
}

func errKind(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Op + " failed"
	}
	return "request failed"
}

// share runs fn once per key among concurrent callers. fn runs on a context
// detached from any one caller, so a caller that gives up does not fail the
// others; each caller still stops waiting at its own deadline.
func (c *Client) share(ctx context.Context, key string, fn func(context.Context) (any, error)) (any, error) {
	c.mu.Lock()
	cl, ok := c.calls[key]
	if !ok {
		cl = &call{done: make(chan struct{})}
		c.calls[key] = cl
		c.mu.Unlock()
		go func() {
			cl.val, cl.err = fn(context.WithoutCancel(ctx))
			c.mu.Lock()
			delete(c.calls, key)
			c.mu.Unlock()
			close(cl.done)
		}()
	} else {
		c.mu.Unlock()
	}
	select {
	case <-cl.done:
		return cl.val, cl.err
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, errKind(ctx.Err()))
	}
}

// ---- resource config ----

// resourceBody is `GET /tr/resources/{id}` (services/console/src/tracer-internal.ts).
type resourceBody struct {
	TeamID         *string `json:"teamId"`
	ProjectID      *string `json:"projectId"`
	WriteKeySha256 *string `json:"writeKeySha256"`
	State          string  `json:"state"`
	DailyBytes     int64   `json:"dailyBytes"`
}

// Lookup implements resource.Source.
func (c *Client) Lookup(ctx context.Context, id string) (resource.Resource, error) {
	if !config.ResourceIDPattern.MatchString(id) {
		return resource.Resource{}, resource.ErrNotFound
	}
	now := c.opt.Now()
	c.mu.Lock()
	e, ok := c.configs[id]
	gone, isGone := c.missing[id]
	c.mu.Unlock()
	if ok && now.Sub(e.at) < c.opt.TTL {
		return e.result()
	}
	if isGone && now.Sub(gone) < c.opt.TTL {
		return resource.Resource{}, resource.ErrNotFound
	}
	v, err := c.share(ctx, "res:"+id, func(ctx context.Context) (any, error) {
		c.opt.Metrics.Counters.ConfigFetches.Add(1)
		var b resourceBody
		if err := c.do(ctx, http.MethodGet, "/tr/resources/"+id, nil, &b); err != nil {
			return nil, err
		}
		ne, err := parseResource(id, b)
		if err != nil {
			return nil, err
		}
		ne.at = c.opt.Now()
		c.store(id, ne)
		return ne, nil
	})
	if err == nil {
		return v.(*configEntry).result()
	}
	// The console did not answer: the last answer it gave, within a day.
	if ok && now.Sub(e.at) < c.opt.StaleFor {
		c.opt.Metrics.Counters.ConfigStale.Add(1)
		c.opt.Log.Warn("console unreachable; serving stale resource config", "resource", id, "err", err)
		return e.result()
	}
	// Never ErrNotFound here: ingest would answer 401, which tells a device to stop.
	return resource.Resource{}, err
}

func (e *configEntry) result() (resource.Resource, error) {
	if e.notFound {
		return resource.Resource{}, resource.ErrNotFound
	}
	return e.res, nil
}

func parseResource(id string, b resourceBody) (*configEntry, error) {
	switch b.State {
	case "deleted":
		return &configEntry{notFound: true}, nil
	case "active":
	default:
		return nil, fmt.Errorf("%w: unknown resource state", ErrUnavailable)
	}
	if b.WriteKeySha256 == nil || b.DailyBytes <= 0 {
		return nil, fmt.Errorf("%w: incomplete resource config", ErrUnavailable)
	}
	sum, err := hex.DecodeString(*b.WriteKeySha256)
	if err != nil || len(sum) != sha256.Size {
		return nil, fmt.Errorf("%w: bad writeKeySha256", ErrUnavailable)
	}
	r := resource.Resource{ID: id, State: "active", DailyBytes: b.DailyBytes}
	copy(r.WriteKeySha256[:], sum)
	return &configEntry{res: r}, nil
}

// store caches an entry; past the bound it drops entries older than the stale
// window, then the oldest one. A "deleted" answer goes to its own bounded set
// and drops any config the id had.
func (c *Client) store(id string, e *configEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e.notFound {
		delete(c.configs, id)
		if _, ok := c.missing[id]; !ok && len(c.missing) >= c.opt.MaxConfigs {
			now := c.opt.Now()
			for k, at := range c.missing {
				if now.Sub(at) >= c.opt.TTL {
					delete(c.missing, k)
				}
			}
			if len(c.missing) >= c.opt.MaxConfigs {
				clear(c.missing)
			}
		}
		c.missing[id] = e.at
		return
	}
	delete(c.missing, id)
	if _, ok := c.configs[id]; !ok && len(c.configs) >= c.opt.MaxConfigs {
		now := c.opt.Now()
		var oldestID string
		var oldest time.Time
		for k, v := range c.configs {
			if now.Sub(v.at) >= c.opt.StaleFor {
				delete(c.configs, k)
				continue
			}
			if oldestID == "" || v.at.Before(oldest) {
				oldestID, oldest = k, v.at
			}
		}
		if len(c.configs) >= c.opt.MaxConfigs {
			delete(c.configs, oldestID)
		}
	}
	c.configs[id] = e
}

// Forget drops a resource from the caches (after its data was purged).
func (c *Client) Forget(id string) {
	c.mu.Lock()
	delete(c.configs, id)
	delete(c.missing, id)
	c.mu.Unlock()
}

// ---- read authorization ----

type authzBody struct {
	Allowed  bool   `json:"allowed"`
	MemberID string `json:"memberId"`
	Reason   string `json:"reason"`
}

// Authorize implements query.Authorizer.
func (c *Client) Authorize(ctx context.Context, token, resourceID string) error {
	if !config.ServerReadTokenPattern.MatchString(token) {
		return query.ErrUnauthenticated
	}
	if !config.ResourceIDPattern.MatchString(resourceID) {
		return query.ErrForbidden
	}
	key := sha256.Sum256([]byte(token + "\x00" + resourceID))
	now := c.opt.Now()
	c.mu.Lock()
	v, ok := c.verdicts[key]
	c.mu.Unlock()
	if ok && now.Sub(v.at) < c.opt.TTL {
		c.opt.Metrics.Counters.AuthzCacheHits.Add(1)
		return v.err
	}
	got, err := c.share(ctx, "authz:"+hex.EncodeToString(key[:]), func(ctx context.Context) (any, error) {
		c.opt.Metrics.Counters.AuthzCalls.Add(1)
		var b authzBody
		if err := c.do(ctx, http.MethodPost, "/tr/authz", map[string]string{"token": token, "resourceId": resourceID}, &b); err != nil {
			return nil, err
		}
		var verr error
		switch {
		case b.Allowed:
		case b.Reason == "unknown_token":
			verr = query.ErrUnauthenticated
		case b.Reason == "denied":
			verr = query.ErrForbidden
		default:
			return nil, fmt.Errorf("%w: unknown authz reason", ErrUnavailable)
		}
		c.remember(key, verdict{err: verr, at: c.opt.Now()})
		return verr, nil
	})
	if err != nil {
		// Fail closed, never a stale verdict: a revoked token must stop working.
		return fmt.Errorf("%w: %w", query.ErrUnavailable, err)
	}
	if got == nil {
		return nil
	}
	return got.(error)
}

func (c *Client) remember(key [32]byte, v verdict) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.verdicts) >= c.opt.MaxVerdict {
		now := c.opt.Now()
		for k, old := range c.verdicts {
			if now.Sub(old.at) >= c.opt.TTL {
				delete(c.verdicts, k)
			}
		}
		if len(c.verdicts) >= c.opt.MaxVerdict {
			// Still full of fresh verdicts: start over rather than grow.
			clear(c.verdicts)
		}
	}
	c.verdicts[key] = v
}

// ---- health and deleted ids ----

type healthBody struct {
	Service    string `json:"service"`
	Tracer     bool   `json:"tracer"`
	Configured bool   `json:"configured"`
}

// Health asks `GET /tr/health` (cached HealthTTL, shared). ok only for a
// console that serves the tracer routes and holds a token; the state string
// is for `/healthz`.
func (c *Client) Health(ctx context.Context) (string, bool) {
	c.mu.Lock()
	h := c.health
	c.mu.Unlock()
	if !h.at.IsZero() && c.opt.Now().Sub(h.at) < HealthTTL {
		return h.state, h.ok
	}
	v, err := c.share(ctx, "health", func(ctx context.Context) (any, error) {
		state, ok := c.probeHealth(ctx)
		r := healthResult{state: state, ok: ok, at: c.opt.Now()}
		c.mu.Lock()
		c.health = r
		c.mu.Unlock()
		return r, nil
	})
	if err != nil {
		return "unreachable", false
	}
	r := v.(healthResult)
	return r.state, r.ok
}

// freshHealth drops the cached health answer (the purge decides on a live one).
func (c *Client) freshHealth(ctx context.Context) (string, bool) {
	c.mu.Lock()
	c.health = healthResult{}
	c.mu.Unlock()
	return c.Health(ctx)
}

func (c *Client) probeHealth(ctx context.Context) (string, bool) {
	var b healthBody
	if err := c.do(ctx, http.MethodGet, "/tr/health", nil, &b); err != nil {
		return "unreachable", false
	}
	switch {
	case b.Service != "yyt-console" || !b.Tracer:
		return "not_console", false
	case !b.Configured:
		return "not_configured", false
	}
	return "ok", true
}

type deletedBody struct {
	IDs []string `json:"ids"`
}

// DeletedIDs lists resources deleted long enough ago to purge. It asks only
// after Health proves the base URL is a configured console, and returns
// nothing on any doubt: a wrong answer here deletes data.
func (c *Client) DeletedIDs(ctx context.Context) ([]string, error) {
	if state, ok := c.freshHealth(ctx); !ok {
		return nil, fmt.Errorf("%w: console health %s", ErrUnavailable, state)
	}
	var b deletedBody
	if err := c.do(ctx, http.MethodGet, "/tr/resources/deleted", nil, &b); err != nil {
		return nil, err
	}
	if b.IDs == nil {
		return nil, fmt.Errorf("%w: malformed deleted list", ErrUnavailable)
	}
	if len(b.IDs) > MaxDeletedIDs {
		return nil, fmt.Errorf("%w: deleted list too long", ErrUnavailable)
	}
	out := make([]string, 0, len(b.IDs))
	for _, id := range b.IDs {
		if !config.ResourceIDPattern.MatchString(id) {
			return nil, fmt.Errorf("%w: malformed id in deleted list", ErrUnavailable)
		}
		out = append(out, id)
	}
	return out, nil
}

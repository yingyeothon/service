// Package authn verifies a client's JWT by calling the auth service
// (`GET /c/{authChannelId}/verify`). The gateway holds no channel secret
// (`docs/auth-game-contract.md`, *Platform gateway path*); it caches the
// answer keyed by a digest of the token until the token's `exp`, because
// auth's reserved concurrency is 10 and a dungeon start connects 8 players
// at once.
package authn

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Identity is a verified token.
type Identity struct {
	UserID    string
	ChannelID string
	Exp       time.Time
}

// ErrUnauthorized is a token auth refused (401/403/410 from auth).
var ErrUnauthorized = errors.New("token rejected")

// ErrBusy means the in-flight verify budget is exhausted: auth's reserved
// concurrency is 10 and a flood of distinct bad tokens must fail here, fast,
// rather than throttle every other auth consumer.
var ErrBusy = errors.New("too many verifications in flight")

// maxInflight is the verify concurrency budget (below auth's 10).
const maxInflight = 8

// callTimeout bounds one auth round trip; the shared call runs on its own
// context so one caller's cancel cannot fail the others waiting on it.
const callTimeout = 5 * time.Second

// Verifier calls auth and caches.
type Verifier struct {
	http *http.Client
	now  func() time.Time
	log  *slog.Logger
	// MaxCache bounds the positive cache; beyond it the oldest expiring
	// entries are evicted. 10 players × a handful of tokens never reaches it.
	maxCache int
	onCall   func()
	onHit    func()

	mu       sync.Mutex
	cache    map[string]cached
	inflight map[string]*call
	sem      chan struct{}
}

type cached struct {
	id  Identity
	exp time.Time
}

type call struct {
	done chan struct{}
	id   Identity
	err  error
}

// Options configures a Verifier.
type Options struct {
	HTTP   *http.Client
	Now    func() time.Time
	Logger *slog.Logger
	OnCall func()
	OnHit  func()
}

// New builds a Verifier.
func New(o Options) *Verifier {
	v := &Verifier{http: o.HTTP, now: o.Now, log: o.Logger, maxCache: 4096, onCall: o.OnCall, onHit: o.OnHit,
		cache: map[string]cached{}, inflight: map[string]*call{}, sem: make(chan struct{}, maxInflight)}
	if v.http == nil {
		v.http = &http.Client{Timeout: 5 * time.Second}
	}
	if v.now == nil {
		v.now = time.Now
	}
	if v.log == nil {
		v.log = slog.Default()
	}
	if v.onCall == nil {
		v.onCall = func() {}
	}
	if v.onHit == nil {
		v.onHit = func() {}
	}
	return v
}

// negativeTTL keeps a refused token from being retried against auth on every
// reconnect attempt; it is short so a token that becomes valid (clock skew)
// is not locked out.
const negativeTTL = 5 * time.Second

// Verify checks the token against verifyURL. The cache key includes the URL:
// one token is legitimately reused across a lobby and a q channel that share
// an auth channel, but a channel pointing at a different auth channel must
// re-verify.
func (v *Verifier) Verify(ctx context.Context, verifyURL, bearer string) (Identity, error) {
	now := v.now()
	if bearer == "" || len(bearer) > 8192 || !printableASCII(bearer) || !plausibleJWT(bearer, now) {
		return Identity{}, ErrUnauthorized
	}
	key := digest(verifyURL, bearer)
	v.mu.Lock()
	if c, ok := v.cache[key]; ok {
		if now.Before(c.exp) {
			v.mu.Unlock()
			if c.id.UserID == "" {
				return Identity{}, ErrUnauthorized
			}
			v.onHit()
			return c.id, nil
		}
		delete(v.cache, key)
	}
	if cl, ok := v.inflight[key]; ok {
		v.mu.Unlock()
		select {
		case <-cl.done:
			return cl.id, cl.err
		case <-ctx.Done():
			return Identity{}, ctx.Err()
		}
	}
	select {
	case v.sem <- struct{}{}:
	default:
		v.mu.Unlock()
		return Identity{}, ErrBusy
	}
	cl := &call{done: make(chan struct{})}
	v.inflight[key] = cl
	v.mu.Unlock()

	go func() {
		defer func() { <-v.sem }()
		cctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		defer cancel()
		id, err := v.call(cctx, verifyURL, bearer)
		cl.id, cl.err = id, err
		v.mu.Lock()
		delete(v.inflight, key)
		switch {
		case err == nil:
			exp := id.Exp
			if exp.After(now.Add(24 * time.Hour)) {
				exp = now.Add(24 * time.Hour)
			}
			v.store(key, cached{id: id, exp: exp})
		case errors.Is(err, ErrUnauthorized):
			v.store(key, cached{exp: now.Add(negativeTTL)})
		}
		v.mu.Unlock()
		close(cl.done)
	}()
	select {
	case <-cl.done:
		return cl.id, cl.err
	case <-ctx.Done():
		return Identity{}, ctx.Err()
	}
}

// plausibleJWT is the syntactic pre-check that keeps junk off the auth
// service: three base64url segments, a JSON payload, and an `exp` that is
// not already in the past. It proves nothing — auth still verifies the
// signature — it only refuses what auth would refuse anyway, for free.
func plausibleJWT(bearer string, now time.Time) bool {
	parts := strings.Split(bearer, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Exp float64 `json:"exp"`
		Sub string  `json:"sub"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Sub == "" || claims.Exp <= 0 {
		return false
	}
	return time.Unix(int64(claims.Exp), 0).After(now.Add(-30 * time.Second))
}

func (v *Verifier) store(key string, c cached) {
	if len(v.cache) >= v.maxCache {
		// Evict whatever expires first; the map is small enough to scan.
		var oldest string
		var when time.Time
		for k, e := range v.cache {
			if oldest == "" || e.exp.Before(when) {
				oldest, when = k, e.exp
			}
		}
		delete(v.cache, oldest)
	}
	v.cache[key] = c
}

func (v *Verifier) call(ctx context.Context, verifyURL, bearer string) (Identity, error) {
	v.onCall()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, verifyURL, nil)
	if err != nil {
		return Identity{}, err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json")
	res, err := v.http.Do(req)
	if err != nil {
		// The transport error names the host, never the token.
		return Identity{}, fmt.Errorf("auth: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 16<<10))
	if err != nil {
		return Identity{}, fmt.Errorf("auth: %w", err)
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusGone, http.StatusNotFound:
		return Identity{}, ErrUnauthorized
	default:
		return Identity{}, fmt.Errorf("auth: HTTP %d", res.StatusCode)
	}
	var out struct {
		UserID    string `json:"userId"`
		Exp       int64  `json:"exp"`
		ChannelID string `json:"channelId"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.UserID == "" || out.Exp <= 0 {
		return Identity{}, errors.New("auth: malformed verify response")
	}
	id := Identity{UserID: out.UserID, ChannelID: out.ChannelID, Exp: time.Unix(out.Exp, 0)}
	if !id.Exp.After(v.now()) {
		return Identity{}, ErrUnauthorized
	}
	return id, nil
}

func digest(url, bearer string) string {
	h := sha256.New()
	h.Write([]byte(url))
	h.Write([]byte{0})
	h.Write([]byte(bearer))
	return hex.EncodeToString(h.Sum(nil))
}

// printableASCII refuses anything that cannot travel in a header: a control
// character would make the HTTP client fail with an error that echoes the
// value (`rules/security.md`).
func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

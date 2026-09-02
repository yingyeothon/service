// Package console reads channel configuration from the console API
// (`GET /gw/channels/{id}`, `docs/decisions.md` *Realtime gateway*). The
// gateway never opens a MariaDB connection: this HTTP read keeps it out of the
// database connection budget and out of the schema.
package console

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Kind is a gateway channel kind.
type Kind string

const (
	KindLobby Kind = "lobby"
	KindQ     Kind = "q"
)

// SayScope is a permitted chat scope.
type SayScope string

// Capabilities mirrors `LobbyCapabilities` in `@yyt/console-db`.
type Capabilities struct {
	Pos   bool       `json:"pos"`
	Say   []SayScope `json:"say"`
	Party bool       `json:"party"`
	Event bool       `json:"event"`
	Debug bool       `json:"debug"`
}

// AllowsSay reports whether the scope is enabled.
func (c Capabilities) AllowsSay(scope string) bool {
	for _, s := range c.Say {
		if string(s) == scope {
			return true
		}
	}
	return false
}

// LobbyConfig mirrors `LobbyChannelConfig` in `@yyt/console-db`.
type LobbyConfig struct {
	AuthChannelID   string       `json:"authChannelId"`
	Capabilities    Capabilities `json:"capabilities"`
	FlushIntervalMs int          `json:"flushIntervalMs"`
	MaxMoveDelta    float64      `json:"maxMoveDelta"`
	RateLimit       int          `json:"rateLimit"`
	PartySizeMax    int          `json:"partySizeMax"`
	DefaultZone     string       `json:"defaultZone"`
	MapURL          string       `json:"mapUrl"`
	// MaxPeers caps every view: the nearest MaxPeers peers of the zone (or
	// of the AOI box) are in view, ties by userId. Always applied, so every
	// snapshot and pos batch fits the outbound cap (`todo/28`).
	MaxPeers int `json:"maxPeers"`
	// AOI is the optional area-of-interest box (`todo/26`); nil means the
	// range is the whole zone (the MaxPeers cut still applies).
	AOI *LobbyAOI `json:"aoi,omitempty"`
}

// LobbyAOI mirrors `LobbyChannelConfig.aoi`: a peer is in view when both
// |dx| and |dy| are within Range of the viewer (a box, Chebyshev distance).
// MaxPeers is read only from rows written before it moved to the top level.
type LobbyAOI struct {
	Range    float64 `json:"range"`
	MaxPeers int     `json:"maxPeers,omitempty"`
}

// Redis is the derived name block of a `q` channel (`gatewayRedis` in the
// console). The gateway uses three of them; the rest are the participant's.
type Redis struct {
	EventKeyPrefix   string `json:"eventKeyPrefix"`
	QueueKeyPrefix   string `json:"queueKeyPrefix"`
	LockKeyPrefix    string `json:"lockKeyPrefix"`
	AwaiterKeyPrefix string `json:"awaiterKeyPrefix"`
	ChannelPrefix    string `json:"channelPrefix"`
}

// Channel is the response of `GET /gw/channels/{id}`.
type Channel struct {
	ID            string `json:"id"`
	Kind          Kind   `json:"kind"`
	Name          string `json:"name"`
	ExpiresAt     int64  `json:"expiresAt"`
	AuthVerifyURL string `json:"authVerifyUrl"`
	// Lobby is decoded from `config` when Kind is `lobby`.
	Lobby *LobbyConfig `json:"-"`
	// AuthChannelID is present for every kind.
	AuthChannelID string `json:"-"`
	Redis         *Redis `json:"redis,omitempty"`
}

// Lookup outcomes the caller must tell apart: a missing channel is a client
// error, a gone one closes existing sockets, an unconfigured console is an
// operator error, and anything else is a retry.
var (
	ErrNotFound      = errors.New("channel not found")
	ErrGone          = errors.New("channel is expired or disabled")
	ErrNotConfigured = errors.New("console gateway access is not configured")
	ErrUnauthorized  = errors.New("gateway token rejected by console")
)

// Client fetches and caches channel configs.
type Client struct {
	base   string
	token  string
	http   *http.Client
	ttl    time.Duration
	now    func() time.Time
	log    *slog.Logger
	onHit  func()
	onMiss func()

	mu    sync.Mutex
	cache map[string]entry
	// inflight dedupes concurrent misses for one channel: a dungeon start
	// connects 8 players at once and must not become 8 console calls.
	inflight map[string]*call
}

type entry struct {
	ch  *Channel
	err error
	exp time.Time
}

type call struct {
	done chan struct{}
	ch   *Channel
	err  error
}

// Options configures a Client.
type Options struct {
	BaseURL string
	Token   string
	TTL     time.Duration
	HTTP    *http.Client
	Now     func() time.Time
	Logger  *slog.Logger
	// OnFetch is called on every console round trip (metrics).
	OnFetch func()
}

// New builds a Client.
func New(o Options) *Client {
	c := &Client{
		base:     strings.TrimRight(o.BaseURL, "/"),
		token:    o.Token,
		http:     o.HTTP,
		ttl:      o.TTL,
		now:      o.Now,
		log:      o.Logger,
		cache:    map[string]entry{},
		inflight: map[string]*call{},
		onMiss:   o.OnFetch,
	}
	if c.http == nil {
		c.http = &http.Client{Timeout: 5 * time.Second}
	}
	if c.ttl == 0 {
		c.ttl = 60 * time.Second
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	if c.onMiss == nil {
		c.onMiss = func() {}
	}
	return c
}

// Health probes `GET /gw/health`. It distinguishes "wrong console or one older
// than these routes" from "channel gone" (both would be a bare 404 otherwise).
func (c *Client) Health(ctx context.Context) (configured bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/gw/health", nil)
	if err != nil {
		return false, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false, fmt.Errorf("console health: HTTP %d", res.StatusCode)
	}
	var body struct {
		Gateway    bool `json:"gateway"`
		Configured bool `json:"configured"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&body); err != nil {
		return false, fmt.Errorf("console health: %w", err)
	}
	if !body.Gateway {
		return false, errors.New("console health: not a gateway-aware console")
	}
	return body.Configured, nil
}

// idShape is what the console mints (`{kind}_{16 hex}`); anything else is
// refused here so an unauthenticated flood of random ids never reaches the
// console or the negative cache.
var idShape = regexp.MustCompile(`^[a-z]{1,16}_[0-9a-f]{8,32}$`)

// ValidID reports whether id has the console's id shape.
func ValidID(id string) bool { return idShape.MatchString(id) }

// maxCache bounds the config cache; the console holds far fewer live
// channels than this, so hitting it means abuse and the oldest entry goes.
const maxCache = 1024

// fetchTimeout bounds one console round trip. The shared fetch runs on its
// own context, not the first caller's request context, so one client
// aborting its handshake cannot fail the seven others waiting on it.
const fetchTimeout = 5 * time.Second

// Get returns the channel, from cache when fresh. Negative answers
// (`ErrNotFound`, `ErrGone`) are cached for the same TTL so a client
// hammering a dead channel id does not hammer the console; transport errors
// are not cached.
func (c *Client) Get(ctx context.Context, id string) (*Channel, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	c.mu.Lock()
	if e, ok := c.cache[id]; ok && c.now().Before(e.exp) {
		c.mu.Unlock()
		return e.ch, e.err
	}
	if cl, ok := c.inflight[id]; ok {
		c.mu.Unlock()
		select {
		case <-cl.done:
			return cl.ch, cl.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	cl := &call{done: make(chan struct{})}
	c.inflight[id] = cl
	c.mu.Unlock()

	go func() {
		fctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
		defer cancel()
		ch, err := c.fetch(fctx, id)
		cl.ch, cl.err = ch, err
		c.mu.Lock()
		delete(c.inflight, id)
		if err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, ErrGone) {
			c.store(id, entry{ch: ch, err: err, exp: c.now().Add(c.ttl)})
		}
		c.mu.Unlock()
		close(cl.done)
	}()
	select {
	case <-cl.done:
		return cl.ch, cl.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// store inserts under the lock, evicting expired entries first and then the
// soonest-expiring one when the cache is still full.
func (c *Client) store(id string, e entry) {
	if len(c.cache) >= maxCache {
		now := c.now()
		for k, v := range c.cache {
			if !now.Before(v.exp) {
				delete(c.cache, k)
			}
		}
	}
	if len(c.cache) >= maxCache {
		var oldest string
		var when time.Time
		for k, v := range c.cache {
			if oldest == "" || v.exp.Before(when) {
				oldest, when = k, v.exp
			}
		}
		delete(c.cache, oldest)
	}
	c.cache[id] = e
}

// Invalidate forgets a cached channel (used when a socket must re-check).
func (c *Client) Invalidate(id string) {
	c.mu.Lock()
	delete(c.cache, id)
	c.mu.Unlock()
}

func (c *Client) fetch(ctx context.Context, id string) (*Channel, error) {
	c.onMiss()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/gw/channels/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("console: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("console: %w", err)
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	case http.StatusGone:
		return nil, ErrGone
	case http.StatusUnauthorized:
		return nil, ErrUnauthorized
	case http.StatusServiceUnavailable:
		var e struct {
			Details struct {
				Reason string `json:"reason"`
			} `json:"details"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Details.Reason == "gateway_not_configured" {
			return nil, ErrNotConfigured
		}
		return nil, fmt.Errorf("console: HTTP 503")
	default:
		return nil, fmt.Errorf("console: HTTP %d", res.StatusCode)
	}
	return decode(body)
}

func decode(body []byte) (*Channel, error) {
	var raw struct {
		Channel
		Config json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("console: bad channel body: %w", err)
	}
	ch := raw.Channel
	if ch.ID == "" || ch.AuthVerifyURL == "" {
		return nil, errors.New("console: channel body lacks id or authVerifyUrl")
	}
	if !strings.HasPrefix(ch.AuthVerifyURL, "https://") && !strings.HasPrefix(ch.AuthVerifyURL, "http://") {
		return nil, errors.New("console: authVerifyUrl is not http(s)")
	}
	switch ch.Kind {
	case KindLobby:
		var lc LobbyConfig
		if err := json.Unmarshal(raw.Config, &lc); err != nil {
			return nil, fmt.Errorf("console: bad lobby config: %w", err)
		}
		if lc.FlushIntervalMs <= 0 {
			lc.FlushIntervalMs = 200
		}
		if lc.RateLimit <= 0 {
			lc.RateLimit = 20
		}
		if lc.PartySizeMax <= 0 {
			lc.PartySizeMax = 4
		}
		if lc.MaxMoveDelta <= 0 {
			lc.MaxMoveDelta = 3
		}
		if lc.AOI != nil {
			// The console enforces 1..256; clamp here too so a hand-edited
			// row cannot blow up the grid or the frame cap.
			if lc.AOI.Range <= 0 {
				return nil, errors.New("console: lobby aoi.range must be positive")
			}
			if lc.AOI.Range < 1 {
				lc.AOI.Range = 1
			} else if lc.AOI.Range > 256 {
				lc.AOI.Range = 256
			}
			// A row from before the cap moved to the top level.
			if lc.MaxPeers <= 0 && lc.AOI.MaxPeers > 0 {
				lc.MaxPeers = lc.AOI.MaxPeers
			}
			lc.AOI.MaxPeers = 0
		}
		if lc.MaxPeers <= 0 {
			lc.MaxPeers = 64
		} else if lc.MaxPeers > 256 {
			lc.MaxPeers = 256
		}
		ch.Lobby = &lc
		ch.AuthChannelID = lc.AuthChannelID
	case KindQ:
		var qc struct {
			AuthChannelID string `json:"authChannelId"`
		}
		if err := json.Unmarshal(raw.Config, &qc); err != nil {
			return nil, fmt.Errorf("console: bad q config: %w", err)
		}
		ch.AuthChannelID = qc.AuthChannelID
		if ch.Redis == nil || ch.Redis.QueueKeyPrefix == "" || ch.Redis.EventKeyPrefix == "" || ch.Redis.ChannelPrefix == "" {
			return nil, errors.New("console: q channel lacks the redis block")
		}
	default:
		return nil, fmt.Errorf("console: unsupported channel kind %q", ch.Kind)
	}
	return &ch, nil
}

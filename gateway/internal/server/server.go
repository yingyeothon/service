// Package server is the HTTP front: `/livez`, `/healthz`, `/metrics`, and
// the WebSocket endpoint `/?channel={id}[&gameId=…]` that picks the strategy
// from the channel kind (`todo/14` §2.2).
package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/yingyeothon/service/gateway/internal/authn"
	"github.com/yingyeothon/service/gateway/internal/conn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/lobby"
	"github.com/yingyeothon/service/gateway/internal/metrics"
	"github.com/yingyeothon/service/gateway/internal/q"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

// Version is stamped by the release build.
var Version = "dev"

// Options wires the server.
type Options struct {
	Stage     string
	Console   *console.Client
	Verifier  *authn.Verifier
	Redis     *redisx.Client
	Registry  *metrics.Registry
	Logger    *slog.Logger
	ConfigTTL time.Duration
	Limits    conn.Limits
	// MaxConnections caps live sockets (default 64; the design ceiling is
	// 10 players, so anything near this is abuse).
	MaxConnections int
	// OperatorToken unlocks the per-channel `/metrics` detail (the same
	// shared secret the console trusts). Empty disables the detail.
	OperatorToken string
}

// Server owns the per-channel hubs and bridges.
type Server struct {
	stage    string
	console  *console.Client
	verifier *authn.Verifier
	rdb      *redisx.Client
	reg      *metrics.Registry
	log      *slog.Logger
	ttl      time.Duration
	limits   conn.Limits
	maxConns int64
	opToken  []byte
	instance string
	started  time.Time
	// dropLogAt throttles the oversized-frame warning per channel: a zone
	// over the cap drops one frame per socket per tick, and one line per
	// drop would be a flood where a counter already exists.
	dropLogMu sync.Mutex
	dropLogAt map[string]time.Time
	now       func() time.Time

	mu       sync.Mutex
	hubs     map[string]*lobby.Hub
	bridges  map[string]*q.Bridge
	wg       sync.WaitGroup
	shutting bool
	stop     chan struct{}
	// handshake limiter per client address, plus a log throttle.
	buckets   map[string]*bucket
	lastSweep time.Time
	logAt     map[string]time.Time
	// health caches the console probe so a public poller cannot turn
	// `/healthz` into a console Lambda invocation per hit.
	healthAt      time.Time
	healthConsole string
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Handshake limits per client address: a burst of 10, refilled at 2/s. A
// browser reconnect loop stays under it; a flood does not.
const (
	handshakeBurst  = 10
	handshakeRate   = 2
	bucketTTL       = 5 * time.Minute
	healthProbeTTL  = 5 * time.Second
	logThrottle     = 30 * time.Second
	joinRetries     = 3
	rejectLogPeriod = 60 * time.Second
)

// New builds a Server and starts the config refresh loop.
func New(o Options) *Server {
	s := &Server{stage: o.Stage, console: o.Console, verifier: o.Verifier, rdb: o.Redis, reg: o.Registry, log: o.Logger,
		ttl: o.ConfigTTL, limits: o.Limits, maxConns: int64(o.MaxConnections), instance: shortID(), started: time.Now(), now: time.Now,
		hubs: map[string]*lobby.Hub{}, bridges: map[string]*q.Bridge{}, stop: make(chan struct{}),
		buckets: map[string]*bucket{}, logAt: map[string]time.Time{}}
	if s.log == nil {
		s.log = slog.Default()
	}
	if s.reg == nil {
		s.reg = metrics.New()
	}
	if s.ttl == 0 {
		s.ttl = 60 * time.Second
	}
	if s.limits.MaxInbound == 0 {
		s.limits = conn.DefaultLimits()
	}
	if s.maxConns <= 0 {
		s.maxConns = 64
	}
	if o.OperatorToken != "" {
		sum := sha256.Sum256([]byte(o.OperatorToken))
		s.opToken = sum[:]
	}
	go s.refreshLoop()
	return s
}

// Handler returns the HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", s.livez)
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /metrics", s.metrics)
	mux.HandleFunc("GET /{$}", s.websocket)
	mux.HandleFunc("GET /parties/{partyId}", s.party)
	return mux
}

// livez is liveness only: the process is up and not draining. Wire restart
// policies to this, never to /healthz — a console redeploy must not restart
// the gateway and disconnect every player.
func (s *Server) livez(w http.ResponseWriter, _ *http.Request) {
	if s.isShutting() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"service": "yyt-gateway", "live": false, "shuttingDown": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service": "yyt-gateway", "live": true, "version": Version, "instance": s.instance})
}

// healthz is readiness: Redis pings and the console reports a configured
// gateway token. The console probe is cached for a few seconds.
func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	body := map[string]any{"service": "yyt-gateway", "version": Version, "stage": s.stage, "instance": s.instance,
		"uptimeSec": int(time.Since(s.started).Seconds()), "connections": s.reg.Gauges.Connections.Load(), "shuttingDown": s.isShutting()}
	status := http.StatusOK
	if err := s.rdb.Ping(ctx); err != nil {
		body["redis"] = "down"
		status = http.StatusServiceUnavailable
	} else {
		body["redis"] = "ok"
	}
	consoleState := s.consoleHealth(ctx)
	body["console"] = consoleState
	if consoleState != "ok" {
		status = http.StatusServiceUnavailable
	}
	if s.isShutting() {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, body)
}

func (s *Server) consoleHealth(ctx context.Context) string {
	s.mu.Lock()
	if s.now().Sub(s.healthAt) < healthProbeTTL {
		state := s.healthConsole
		s.mu.Unlock()
		return state
	}
	s.mu.Unlock()
	state := "ok"
	if configured, err := s.console.Health(ctx); err != nil {
		state = "down"
	} else if !configured {
		state = "not_configured"
	}
	s.mu.Lock()
	s.healthAt, s.healthConsole = s.now(), state
	s.mu.Unlock()
	return state
}

// metrics serves the process-wide numbers to anyone and the per-channel
// detail only with the operator token (channel ids are targeting material).
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if s.opToken != nil {
		if b := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); b != "" && b != r.Header.Get("Authorization") {
			sum := sha256.Sum256([]byte(b))
			if subtle.ConstantTimeCompare(sum[:], s.opToken) == 1 {
				writeJSON(w, http.StatusOK, s.reg.Detailed())
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, s.reg)
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// The credential is the subprotocol token, not a cookie, so a browser
	// page on any origin may connect; CSRF does not apply.
	CheckOrigin:  func(*http.Request) bool { return true },
	Subprotocols: []string{"bearer"},
}

// bearerFromSubprotocols parses `Sec-WebSocket-Protocol: bearer, <jwt>`.
// The token never sits in the query string (access logs). The header
// carries the credential, so it must never be logged.
func bearerFromSubprotocols(r *http.Request) string {
	offered := websocket.Subprotocols(r)
	for i, p := range offered {
		if p == "bearer" && i+1 < len(offered) {
			return offered[i+1]
		}
	}
	return ""
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	if s.isShutting() {
		s.reject(w, http.StatusServiceUnavailable, "gateway is shutting down")
		return
	}
	if !websocket.IsWebSocketUpgrade(r) {
		writeJSON(w, http.StatusUpgradeRequired, map[string]any{"error": "Upgrade Required", "message": "this endpoint speaks WebSocket; see /healthz"})
		return
	}
	if !s.allowHandshake(clientAddr(r)) {
		s.reject(w, http.StatusTooManyRequests, "too many connection attempts")
		return
	}
	// Cheapest checks first: nothing below costs a console or auth call
	// until the request is at least well-formed.
	channelID := r.URL.Query().Get("channel")
	if channelID == "" {
		s.reject(w, http.StatusBadRequest, "channel query parameter is required")
		return
	}
	if !console.ValidID(channelID) {
		s.reject(w, http.StatusNotFound, "channel not found")
		return
	}
	bearer := bearerFromSubprotocols(r)
	if bearer == "" {
		s.reject(w, http.StatusUnauthorized, "Sec-WebSocket-Protocol: bearer, <jwt> is required")
		return
	}
	if s.reg.Gauges.Connections.Load() >= s.maxConns {
		s.reject(w, http.StatusServiceUnavailable, "gateway is full")
		return
	}
	ctx := r.Context()
	ch, err := s.console.Get(ctx, channelID)
	if err != nil {
		switch {
		case errors.Is(err, console.ErrNotFound):
			s.reject(w, http.StatusNotFound, "channel not found")
		case errors.Is(err, console.ErrGone):
			s.reject(w, http.StatusGone, "channel is expired or disabled")
		case errors.Is(err, console.ErrNotConfigured), errors.Is(err, console.ErrUnauthorized):
			s.throttledLog("console-refused", slog.LevelError, "console refuses gateway reads", "err", err.Error())
			s.reject(w, http.StatusServiceUnavailable, "gateway is not configured")
		default:
			s.throttledLog("console-down", slog.LevelWarn, "console unreachable", "err", err.Error())
			s.reject(w, http.StatusBadGateway, "cannot read channel configuration")
		}
		return
	}
	id, err := s.verifier.Verify(ctx, ch.AuthVerifyURL, bearer)
	if err != nil {
		switch {
		case errors.Is(err, authn.ErrUnauthorized):
			s.reject(w, http.StatusUnauthorized, "token rejected")
		case errors.Is(err, authn.ErrBusy):
			s.reject(w, http.StatusServiceUnavailable, "too many verifications in flight")
		default:
			s.throttledLog("auth-down", slog.LevelWarn, "auth unreachable", "channel", channelID, "err", err.Error())
			s.reject(w, http.StatusBadGateway, "cannot verify token")
		}
		return
	}
	var gameID string
	switch ch.Kind {
	case console.KindLobby:
	case console.KindQ:
		gameID = r.URL.Query().Get("gameId")
		if gameID == "" {
			gameID = r.URL.Query().Get("x-game-id")
		}
		probe := s.bridgeFor(ch)
		if probe == nil {
			s.reject(w, http.StatusServiceUnavailable, "gateway is shutting down")
			return
		}
		if err := probe.Authorize(ctx, gameID, id.UserID); err != nil {
			switch {
			case errors.Is(err, q.ErrUnknownGame), errors.Is(err, q.ErrNotAMember):
				// One code for both: "unknown game" would let a member probe
				// which game ids exist.
				s.reject(w, http.StatusForbidden, "not a member of this game")
			default:
				s.throttledLog("q-authorize", slog.LevelWarn, "q authorize failed", "channel", channelID, "err", err.Error())
				s.reject(w, http.StatusBadGateway, "cannot read the game")
			}
			return
		}
	default:
		s.reject(w, http.StatusNotFound, "channel not found")
		return
	}

	// Register with the drain before upgrading, under the same lock that
	// Shutdown flips `shutting` under, so a socket can never be created after
	// the drain snapshot and outlive it.
	s.mu.Lock()
	if s.shutting {
		s.mu.Unlock()
		s.reject(w, http.StatusServiceUnavailable, "gateway is shutting down")
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote the response.
		s.reg.Counters.CountRejection(http.StatusBadRequest)
		return
	}
	limits := s.limits
	if ch.Lobby != nil && ch.Lobby.RateLimit > 0 {
		limits.RateLimit = ch.Lobby.RateLimit
	}
	connID := s.instance + ":" + shortID()
	stats := s.reg.Channel(channelID)
	log := s.log.With("channel", channelID, "kind", string(ch.Kind), "conn", connID, "user", id.UserID)
	c := conn.New(ws, connID, id.UserID, limits, conn.Hooks{
		OnSent:    func() { s.reg.Counters.OutboundFrames.Add(1) },
		OnDropped: func() { s.reg.Counters.DroppedFrames.Add(1); stats.Dropped.Add(1) },
		OnOversized: func(size int) {
			s.reg.Counters.OversizedFrames.Add(1)
			// A counter alone cannot say which channel outgrew the cap.
			if s.shouldLogDrop(channelID) {
				log.Warn("outbound frame dropped", "bytes", size, "cap", limits.MaxOutbound)
			}
		},
		OnQueueDepth: s.reg.Gauges.RecordQueueDepth,
		// Counted only: the hook runs under the hub lock, and the
		// "disconnected" line below carries the 4005.
		OnTooSlow: func() {
			s.reg.Counters.TooSlow.Add(1)
			stats.TooSlow.Add(1)
		},
	})
	s.reg.Counters.ConnectionsAccepted.Add(1)
	s.reg.Gauges.Connections.Add(1)
	defer s.reg.Gauges.Connections.Add(-1)
	log.Info("connected")
	bg := context.Background()
	var readErr error
	if ch.Kind == console.KindLobby {
		// A refresh tick may drop a hub between lookup and join; a stopped
		// hub refuses, and the retry creates a live one.
		var hub *lobby.Hub
		for i := 0; i < joinRetries; i++ {
			if hub = s.hubFor(ch); hub == nil || hub.Join(bg, connID, id.UserID, c) {
				break
			}
			hub = nil
		}
		if hub == nil {
			c.Close(conn.CloseShutdown, "gateway restarting")
			<-c.Done()
			log.Info("disconnected", "code", c.CloseCode(), "reason", "no_hub")
			return
		}
		readErr = c.ReadLoop(func(b []byte) { hub.Handle(bg, connID, b) })
		hub.Leave(bg, connID)
	} else {
		var bridge *q.Bridge
		var joinErr error
		for i := 0; i < joinRetries; i++ {
			bridge = s.bridgeFor(ch)
			if bridge == nil {
				joinErr = q.ErrStopped
				break
			}
			if joinErr = bridge.Join(bg, gameID, connID, id.UserID, c); !errors.Is(joinErr, q.ErrStopped) {
				break
			}
		}
		switch {
		case errors.Is(joinErr, q.ErrAborted):
			c.Close(conn.CloseActorUnavailable, "actor-unavailable")
		case errors.Is(joinErr, q.ErrStopped):
			c.Close(conn.CloseShutdown, "gateway restarting")
		case joinErr != nil:
			c.Close(websocket.CloseInternalServerErr, "cannot join the game")
		}
		if joinErr == nil {
			readErr = c.ReadLoop(func(b []byte) { bridge.Handle(bg, gameID, connID, b) })
			bridge.Leave(bg, gameID, connID)
		}
	}
	<-c.Done()
	log.Info("disconnected", "code", c.CloseCode(), "reason", closeReason(readErr))
}

func closeReason(err error) string {
	switch {
	case err == nil, errors.Is(err, conn.ErrClosed):
		return "closed"
	case errors.Is(err, conn.ErrIdle):
		return "idle"
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		return "client_close:" + itoa(ce.Code)
	}
	return "read_error"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// dropLogEvery is the per-channel throttle of the oversized-frame warning.
const dropLogEvery = 5 * time.Second

func (s *Server) shouldLogDrop(channelID string) bool {
	s.dropLogMu.Lock()
	defer s.dropLogMu.Unlock()
	if s.dropLogAt == nil {
		s.dropLogAt = map[string]time.Time{}
	}
	now := time.Now()
	if now.Sub(s.dropLogAt[channelID]) < dropLogEvery {
		return false
	}
	s.dropLogAt[channelID] = now
	return true
}

// hubFor returns the live hub of a lobby channel, or nil while draining.
// party answers `GET /parties/{partyId}?channel={lobbyId}` with the roster the
// gateway mirrored to Redis, to the bearer of a member's JWT only. It is the
// read a game's dungeon-entry API needs: the client names the party, the
// gateway proves who is in it (`README.md`, "Party roster for games").
func (s *Server) party(w http.ResponseWriter, r *http.Request) {
	reject := func(status int, msg string) {
		s.reg.Counters.PartyRejected.Add(1)
		writeJSON(w, status, map[string]any{"error": http.StatusText(status), "message": msg})
	}
	// Its own bucket: a game's Lambda egress address must not spend the
	// handshake budget of the players behind the same NAT, nor vice versa.
	if !s.allowHandshake("party:" + clientAddr(r)) {
		reject(http.StatusTooManyRequests, "too many requests")
		return
	}
	channelID := r.URL.Query().Get("channel")
	if channelID == "" {
		reject(http.StatusBadRequest, "channel query parameter is required")
		return
	}
	if !console.ValidID(channelID) {
		reject(http.StatusNotFound, "channel not found")
		return
	}
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if bearer == "" || bearer == r.Header.Get("Authorization") {
		reject(http.StatusUnauthorized, "Authorization: Bearer <jwt> is required")
		return
	}
	ctx := r.Context()
	ch, err := s.console.Get(ctx, channelID)
	if err != nil {
		switch {
		case errors.Is(err, console.ErrNotFound):
			reject(http.StatusNotFound, "channel not found")
		case errors.Is(err, console.ErrGone):
			reject(http.StatusGone, "channel is expired or disabled")
		case errors.Is(err, console.ErrNotConfigured), errors.Is(err, console.ErrUnauthorized):
			s.throttledLog("console-refused", slog.LevelError, "console refuses gateway reads", "err", err.Error())
			reject(http.StatusServiceUnavailable, "gateway is not configured")
		default:
			s.throttledLog("console-down", slog.LevelWarn, "console unreachable", "err", err.Error())
			reject(http.StatusBadGateway, "cannot read channel configuration")
		}
		return
	}
	if ch.Kind != console.KindLobby {
		reject(http.StatusNotFound, "channel not found")
		return
	}
	id, err := s.verifier.Verify(ctx, ch.AuthVerifyURL, bearer)
	if err != nil {
		switch {
		case errors.Is(err, authn.ErrUnauthorized):
			reject(http.StatusUnauthorized, "token rejected")
		case errors.Is(err, authn.ErrBusy):
			reject(http.StatusServiceUnavailable, "too many verifications in flight")
		default:
			s.throttledLog("auth-down", slog.LevelWarn, "auth unreachable", "channel", channelID, "err", err.Error())
			reject(http.StatusBadGateway, "cannot verify token")
		}
		return
	}
	roster, err := lobby.ReadRoster(ctx, s.rdb, channelID, r.PathValue("partyId"), id.UserID)
	if err != nil {
		if errors.Is(err, lobby.ErrPartyNotFound) {
			// One code for "no such party" and "not yours": no probing.
			reject(http.StatusNotFound, "party not found")
			return
		}
		s.reg.Counters.RedisErrors.Add(1)
		s.throttledLog("party-redis", slog.LevelWarn, "party read failed", "channel", channelID, "err", err.Error())
		reject(http.StatusBadGateway, "cannot read the party")
		return
	}
	s.reg.Counters.PartyReads.Add(1)
	writeJSON(w, http.StatusOK, roster)
}

func (s *Server) hubFor(ch *console.Channel) *lobby.Hub {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shutting {
		return nil
	}
	h, ok := s.hubs[ch.ID]
	if !ok {
		h = lobby.New(lobby.Options{ChannelID: ch.ID, Config: *ch.Lobby, Redis: s.rdb, Logger: s.log, Registry: s.reg})
		s.hubs[ch.ID] = h
	}
	return h
}

func (s *Server) bridgeFor(ch *console.Channel) *q.Bridge {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shutting {
		return nil
	}
	b, ok := s.bridges[ch.ID]
	if !ok {
		b = q.New(q.Options{ChannelID: ch.ID, Redis: s.rdb, Names: *ch.Redis, Logger: s.log, Registry: s.reg})
		s.bridges[ch.ID] = b
	}
	return b
}

// allowHandshake is the per-address token bucket.
func (s *Server) allowHandshake(addr string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.lastSweep) > bucketTTL {
		for k, b := range s.buckets {
			if now.Sub(b.last) > bucketTTL {
				delete(s.buckets, k)
			}
		}
		s.lastSweep = now
	}
	b, ok := s.buckets[addr]
	if !ok {
		b = &bucket{tokens: handshakeBurst, last: now}
		s.buckets[addr] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * handshakeRate
	if b.tokens > handshakeBurst {
		b.tokens = handshakeBurst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// clientAddr is the peer address without the port. The gateway sits behind
// its own proxy at most, so X-Forwarded-For is deliberately not trusted.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) throttledLog(key string, level slog.Level, msg string, args ...any) {
	now := s.now()
	s.mu.Lock()
	if now.Sub(s.logAt[key]) < logThrottle {
		s.mu.Unlock()
		return
	}
	s.logAt[key] = now
	s.mu.Unlock()
	s.log.Log(context.Background(), level, msg, args...)
}

func (s *Server) isShutting() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shutting
}

// refreshLoop re-reads every active channel once per TTL: a channel that
// expired or was disabled closes its sockets with 4004 rather than living on
// in memory, and edited config (a new map version) reaches the next `hello`.
func (s *Server) refreshLoop() {
	t := time.NewTicker(s.ttl)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.Refresh(context.Background())
		}
	}
}

// Refresh is one pass of refreshLoop; exported for tests.
func (s *Server) Refresh(ctx context.Context) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.hubs)+len(s.bridges))
	for id := range s.hubs {
		ids = append(ids, id)
	}
	for id := range s.bridges {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.console.Invalidate(id)
		ch, err := s.console.Get(ctx, id)
		gone := errors.Is(err, console.ErrNotFound) || errors.Is(err, console.ErrGone)
		var stopHub *lobby.Hub
		var stopBridge *q.Bridge
		var code int
		var reason string
		s.mu.Lock()
		if h, ok := s.hubs[id]; ok {
			switch {
			case gone:
				delete(s.hubs, id)
				stopHub, code, reason = h, conn.CloseChannelGone, "channel is expired or disabled"
			case err == nil && ch.Lobby != nil:
				h.Reconfigure(*ch.Lobby)
				if h.Empty() {
					delete(s.hubs, id)
					stopHub, code, reason = h, websocket.CloseNormalClosure, ""
				}
			}
		}
		if b, ok := s.bridges[id]; ok {
			switch {
			case gone:
				delete(s.bridges, id)
				stopBridge, code, reason = b, conn.CloseChannelGone, "channel is expired or disabled"
			case err == nil && ch.Redis != nil:
				b.Reconfigure(*ch.Redis)
				if b.Empty() {
					delete(s.bridges, id)
					stopBridge, code, reason = b, websocket.CloseNormalClosure, ""
				}
			}
		}
		s.mu.Unlock()
		// Stop outside the lock: it closes sockets, whose handlers take
		// hub/bridge locks of their own.
		if stopHub != nil {
			stopHub.Stop(code, reason)
		}
		if stopBridge != nil {
			stopBridge.Stop(code, reason)
		}
	}
}

// Shutdown is the SIGTERM drain (§2.7): stop accepting, close every socket
// with 1001 — which makes each q socket push its `leave` and unsubscribe on
// the way out — then wait for the handlers, bounded by ctx.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if s.shutting {
		s.mu.Unlock()
		return nil
	}
	s.shutting = true
	close(s.stop)
	hubs := make([]*lobby.Hub, 0, len(s.hubs))
	for _, h := range s.hubs {
		hubs = append(hubs, h)
	}
	bridges := make([]*q.Bridge, 0, len(s.bridges))
	for _, b := range s.bridges {
		bridges = append(bridges, b)
	}
	s.mu.Unlock()
	for _, h := range hubs {
		h.Stop(conn.CloseShutdown, "gateway restarting")
	}
	for _, b := range bridges {
		b.Stop(conn.CloseShutdown, "gateway restarting")
	}
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Draining flips the readiness answer ahead of Shutdown so a proxy can
// stop routing new handshakes before the sockets are closed.
func (s *Server) Draining() {
	s.mu.Lock()
	s.shutting = true
	s.mu.Unlock()
}

func (s *Server) reject(w http.ResponseWriter, status int, msg string) {
	s.reg.Counters.CountRejection(status)
	writeJSON(w, status, map[string]any{"error": http.StatusText(status), "message": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func shortID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// Instance is the per-process prefix of every connection id.
func (s *Server) Instance() string { return strings.Clone(s.instance) }

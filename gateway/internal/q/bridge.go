// Package q implements the `q` strategy (`todo/14` §2.4-§2.5): it bridges a
// client socket to a tslib actor. Inbound frames are `RPUSH`ed to the
// actor's Redis list in tslib's `UserMessage` envelope; outbound
// `GatewayCommand`s arrive over pub/sub and are fanned out to sockets. The
// gateway also owns actor-death detection.
package q

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/yingyeothon/service/gateway/internal/conn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/metrics"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

// Socket is what the bridge needs from a connection.
type Socket interface {
	SendRaw(b []byte) bool
	SendError(code, message string)
	Close(code int, reason string)
	Allow() bool
}

// Abort thresholds (§2.5, settled).
const (
	// DepthCap is the absolute backlog that is unambiguously pathological.
	DepthCap = 200
	// SteadyDepth is the backlog considered healthy between actor polls.
	SteadyDepth = 20
	// NoProgress is how long the depth may stay above SteadyDepth before the
	// actor is declared dead.
	NoProgress = 5 * time.Second
	// badLimit closes a socket that keeps sending refused frames.
	badLimit = 50
	// fakeConnectionID is reserved by tslib and must never be claimed.
	fakeConnectionID = "__FAKE_CONNECTION_ID__"
)

// Error codes sent to clients.
const (
	ErrBadMessage   = "bad_message"
	ErrReservedType = "reserved_type"
	ErrRateLimited  = "rate_limited"
)

// Authorization outcomes for a connect.
var (
	ErrUnknownGame = errors.New("unknown game")
	ErrNotAMember  = errors.New("not a member of this game")
	// ErrAborted: the game's actor was declared dead; a retry needs a new
	// gameId (§2.5), so a reconnect to this one is refused.
	ErrAborted = errors.New("game aborted")
	// ErrStopped: the bridge was dropped (channel gone or shutdown).
	ErrStopped = errors.New("bridge stopped")
)

// logEvery throttles Redis error logging per op.
const logEvery = 5 * time.Second

// subscribeTimeout bounds the SUBSCRIBE handshake of a new game.
const subscribeTimeout = 5 * time.Second

// envelope is tslib's `UserMessage<T>` with `AwaitPolicy.Forget`.
type envelope struct {
	MessageID          string          `json:"messageId"`
	AwaitPolicy        int             `json:"awaitPolicy"`
	AwaitTimeoutMillis int             `json:"awaitTimeoutMillis"`
	Item               json.RawMessage `json:"item"`
}

// command is tslib's `GatewayCommand`.
type command struct {
	Op            string          `json:"op"`
	ConnectionID  string          `json:"connectionId"`
	ConnectionIDs []string        `json:"connectionIds"`
	Message       json.RawMessage `json:"message"`
}

type client struct {
	id       string
	memberID string
	sock     Socket
	bad      int
}

type game struct {
	id       string
	conns    map[string]*client
	byMember map[string]*client
	pubsub   *redis.PubSub
	cancel   context.CancelFunc
	// ready is closed once the subscription is up (or failed: subErr).
	// The SUBSCRIBE round trip runs outside the bridge lock so a stalled
	// Redis cannot freeze every other game on the channel.
	ready       chan struct{}
	subErr      error
	lastHealthy time.Time
	aborted     bool
	// pushFailures counts consecutive failed pushes; the client is told
	// after a few instead of being left in silence.
	pushFailures int
}

// Bridge is one q channel.
type Bridge struct {
	channelID string
	names     console.Redis
	rdb       *redisx.Client
	log       *slog.Logger
	reg       *metrics.Registry
	stats     *metrics.ChannelStats
	now       func() time.Time
	newID     func() string

	mu      sync.Mutex
	games   map[string]*game
	stopped bool
	logAt   map[string]time.Time
}

// Options builds a Bridge.
type Options struct {
	ChannelID string
	Redis     *redisx.Client
	Names     console.Redis
	Logger    *slog.Logger
	Registry  *metrics.Registry
	Now       func() time.Time
	NewID     func() string
}

// New creates a bridge.
func New(o Options) *Bridge {
	b := &Bridge{channelID: o.ChannelID, names: o.Names, rdb: o.Redis, log: o.Logger, reg: o.Registry, now: o.Now, newID: o.NewID,
		games: map[string]*game{}, logAt: map[string]time.Time{}}
	if b.log == nil {
		b.log = slog.Default()
	}
	if b.reg == nil {
		b.reg = metrics.New()
	}
	b.stats = b.reg.Channel(o.ChannelID)
	if b.now == nil {
		b.now = time.Now
	}
	if b.newID == nil {
		b.newID = randomUUID
	}
	return b
}

// Reconfigure applies refreshed derived names (they never change for a given
// channel id, but the console is the source of truth).
func (b *Bridge) Reconfigure(names console.Redis) {
	b.mu.Lock()
	b.names = names
	b.mu.Unlock()
}

// Empty reports whether no game has a socket.
func (b *Bridge) Empty() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.games) == 0
}

// Authorize loads the start event and checks membership (§2.4 steps 3-4).
// `gameId` is client-supplied and this is the check a JWT cannot make.
func (b *Bridge) Authorize(ctx context.Context, gameID, memberID string) error {
	if gameID == "" || len(gameID) > 128 || gameID == fakeConnectionID {
		return ErrUnknownGame
	}
	b.mu.Lock()
	prefix := b.names.EventKeyPrefix
	b.mu.Unlock()
	raw, err := b.rdb.GetRaw(ctx, prefix+gameID)
	if err != nil {
		return err
	}
	if raw == nil {
		return ErrUnknownGame
	}
	var ev struct {
		Members []struct {
			MemberID string `json:"memberId"`
		} `json:"members"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return ErrUnknownGame
	}
	for _, m := range ev.Members {
		if m.MemberID == memberID {
			return nil
		}
	}
	return ErrNotAMember
}

// Join binds an authorized socket to a game: subscribe first, drop a
// previous socket of the same member, then push `enter`.
func (b *Bridge) Join(ctx context.Context, gameID, connID, memberID string, sock Socket) error {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		return ErrStopped
	}
	g, ok := b.games[gameID]
	if !ok {
		g = &game{id: gameID, conns: map[string]*client{}, byMember: map[string]*client{}, lastHealthy: b.now(), ready: make(chan struct{})}
		b.games[gameID] = g
		channel := b.names.ChannelPrefix + gameID
		b.mu.Unlock()
		// Subscribe before pushing: inbound is durable, outbound is not, and
		// the actor learns connection ids only from `enter`.
		gctx, cancel := context.WithCancel(context.Background())
		ps := b.rdb.Subscribe(gctx, channel)
		sctx, scancel := context.WithTimeout(ctx, subscribeTimeout)
		_, err := ps.Receive(sctx)
		scancel()
		b.mu.Lock()
		if err != nil {
			cancel()
			_ = ps.Close()
			g.subErr = err
			if b.games[gameID] == g {
				delete(b.games, gameID)
			}
			close(g.ready)
			b.mu.Unlock()
			b.redisErr("subscribe", redisx.Sanitize(err))
			return err
		}
		g.pubsub, g.cancel = ps, cancel
		b.reg.Gauges.Games.Add(1)
		b.reg.Gauges.Subscriptions.Add(1)
		close(g.ready)
		go b.outboundLoop(gctx, g)
	} else {
		b.mu.Unlock()
		select {
		case <-g.ready:
		case <-ctx.Done():
			return ctx.Err()
		}
		if g.subErr != nil {
			return g.subErr
		}
		b.mu.Lock()
		if b.games[gameID] != g {
			// Dropped between our lookup and now (last socket left, or the
			// bridge stopped); the caller retries and gets a fresh game.
			b.mu.Unlock()
			return ErrStopped
		}
	}
	if g.aborted {
		b.mu.Unlock()
		return ErrAborted
	}
	if old, exists := g.byMember[memberID]; exists {
		// tslib's `processEnter` rebinds the member to the new connection and
		// never closes the old one (`todo/14` §2.4 step 6); no `leave` is pushed
		// for it, because a `leave` naming a connection that was just rebound
		// would be the actor's to misread. The replaced socket's Leave then
		// finds nothing to detach, so account here.
		delete(g.conns, old.id)
		old.sock.Close(conn.CloseReplaced, "replaced by a newer connection")
		b.reg.Counters.SessionsReplaced.Add(1)
		b.stats.Connections.Add(-1)
	}
	cl := &client{id: connID, memberID: memberID, sock: sock}
	g.conns[connID] = cl
	g.byMember[memberID] = cl
	b.mu.Unlock()
	b.stats.Connections.Add(1)

	if _, err := b.rdb.ClaimSession(ctx, "q", b.channelID, memberID, connID); err != nil {
		b.redisErr("claim session", err)
	}
	b.mu.Lock()
	replaced := g.conns[connID] != cl
	b.mu.Unlock()
	if replaced {
		// Replaced while claiming: the key may name this dead connection.
		if err := b.rdb.ReleaseSession(ctx, "q", b.channelID, memberID, connID); err != nil {
			b.redisErr("release session", err)
		}
		return nil
	}
	item, _ := json.Marshal(map[string]string{"type": "enter", "connectionId": connID, "memberId": memberID})
	return b.push(ctx, g, cl, item)
}

// Leave pushes `leave`, releases the session and unsubscribes when the last
// socket of the game closes — in that order (§2.4), so the actor hears the
// leave before the outbound channel goes quiet.
func (b *Bridge) Leave(ctx context.Context, gameID, connID string) {
	b.mu.Lock()
	g := b.games[gameID]
	if g == nil {
		b.mu.Unlock()
		return
	}
	cl, ok := g.conns[connID]
	if !ok {
		b.mu.Unlock()
		return
	}
	delete(g.conns, connID)
	if g.byMember[cl.memberID] == cl {
		delete(g.byMember, cl.memberID)
	}
	aborted := g.aborted
	b.mu.Unlock()
	b.stats.Connections.Add(-1)
	if !aborted {
		item, _ := json.Marshal(map[string]string{"type": "leave", "connectionId": connID})
		_ = b.push(ctx, g, nil, item)
	}
	b.mu.Lock()
	if len(g.conns) == 0 {
		b.dropGameLocked(g)
	}
	b.mu.Unlock()
	if err := b.rdb.ReleaseSession(ctx, "q", b.channelID, cl.memberID, connID); err != nil {
		b.redisErr("release session", err)
	}
}

// Handle forwards one inbound frame: it must be a JSON object with a string
// `type` that is not reserved; `connectionId` is stamped by the gateway.
func (b *Bridge) Handle(ctx context.Context, gameID, connID string, raw []byte) {
	b.mu.Lock()
	g := b.games[gameID]
	if g == nil {
		b.mu.Unlock()
		return
	}
	cl, ok := g.conns[connID]
	if !ok {
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	b.stats.Inbound.Add(1)
	b.reg.Counters.InboundMessages.Add(1)
	if !cl.sock.Allow() {
		b.reg.Counters.RateLimited.Add(1)
		b.refuse(cl, ErrRateLimited, "slow down")
		return
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		b.reg.Counters.BadMessages.Add(1)
		b.refuse(cl, ErrBadMessage, "expected a JSON object")
		return
	}
	var typ string
	if t, ok := obj["type"]; !ok || json.Unmarshal(t, &typ) != nil || typ == "" {
		b.reg.Counters.BadMessages.Add(1)
		b.refuse(cl, ErrBadMessage, "a string `type` is required")
		return
	}
	if typ == "enter" || typ == "leave" {
		b.reg.Counters.BadMessages.Add(1)
		b.refuse(cl, ErrReservedType, "`enter`/`leave` are produced by the gateway")
		return
	}
	// `connectionId` is the only field the actor may trust, and it is the
	// gateway's; `memberId` is stripped so a client cannot smuggle another
	// member's identity into a message an actor reads too casually.
	idJSON, _ := json.Marshal(connID)
	obj["connectionId"] = idJSON
	delete(obj, "memberId")
	item, err := json.Marshal(obj)
	if err != nil {
		b.refuse(cl, ErrBadMessage, "unencodable message")
		return
	}
	_ = b.push(ctx, g, cl, item)
}

func (b *Bridge) refuse(cl *client, code, msg string) {
	cl.sock.SendError(code, msg)
	b.mu.Lock()
	cl.bad++
	tooMany := cl.bad >= badLimit
	b.mu.Unlock()
	if tooMany {
		cl.sock.Close(conn.ClosePolicy, "too many refused messages")
	}
}

// pushFailureLimit is how many consecutive failed pushes close the game's
// sockets: the actor cannot hear them, and silence is the wrong answer.
const pushFailureLimit = 3

// push RPUSHes one envelope and runs actor-death detection on the depth.
// `from` is the sending socket (nil for a gateway-produced `leave`) and is
// told when Redis refuses the push.
func (b *Bridge) push(ctx context.Context, g *game, from *client, item []byte) error {
	env, err := json.Marshal(envelope{MessageID: b.newID(), AwaitPolicy: 0, AwaitTimeoutMillis: 0, Item: item})
	if err != nil {
		return err
	}
	b.mu.Lock()
	key := b.names.QueueKeyPrefix + g.id
	b.mu.Unlock()
	depth, err := b.rdb.Push(ctx, key, env)
	if err != nil {
		b.redisErr("push", err)
		b.mu.Lock()
		g.pushFailures++
		failures := g.pushFailures
		b.mu.Unlock()
		if from != nil {
			from.sock.SendError("unavailable", "message not delivered; retry")
		}
		if failures >= pushFailureLimit {
			b.abort(ctx, g, -1, "redis unavailable")
		}
		return err
	}
	b.reg.Counters.QueuePushes.Add(1)
	if depth > b.stats.QueueDepthMax.Load() {
		b.stats.QueueDepthMax.Store(depth)
	}
	now := b.now()
	b.mu.Lock()
	g.pushFailures = 0
	if depth <= SteadyDepth {
		g.lastHealthy = now
	}
	// A game already dropped from the map (last socket left) must not abort:
	// it would DEL the queue of a successor with the same gameId.
	live := b.games[g.id] == g
	dead := live && (depth > DepthCap || (depth > SteadyDepth && now.Sub(g.lastHealthy) > NoProgress))
	b.mu.Unlock()
	if dead {
		b.abort(ctx, g, depth, "actor not consuming")
	}
	return nil
}

// abort is §2.5 in order: close with 4001, DEL the queue, alarm. The
// The UNSUBSCRIBE is a consequence of the closes, not something abort ensures:
// each closed socket's read loop reaches Leave, and whichever call sees the
// last connection go runs dropGameLocked, which closes the subscription.
func (b *Bridge) abort(ctx context.Context, g *game, depth int64, why string) {
	b.mu.Lock()
	if g.aborted {
		b.mu.Unlock()
		return
	}
	g.aborted = true
	conns := make([]*client, 0, len(g.conns))
	for _, c := range g.conns {
		conns = append(conns, c)
	}
	key := b.names.QueueKeyPrefix + g.id
	b.mu.Unlock()
	for _, c := range conns {
		c.sock.Close(conn.CloseActorUnavailable, "actor-unavailable")
	}
	if err := b.rdb.DelRaw(ctx, key); err != nil {
		b.redisErr("del queue", err)
	}
	b.reg.Counters.Aborts.Add(1)
	b.reg.Gauges.LastAbortUnix.Store(b.now().Unix())
	b.log.Error("q actor unavailable: aborted game", "channel", b.channelID, "game", g.id, "why", why, "depth", depth, "connections", len(conns))
}

func (b *Bridge) dropGameLocked(g *game) {
	if _, ok := b.games[g.id]; !ok {
		return
	}
	delete(b.games, g.id)
	if g.cancel != nil {
		g.cancel()
	}
	if g.pubsub != nil {
		_ = g.pubsub.Close()
	}
	b.reg.Gauges.Games.Add(-1)
	b.reg.Gauges.Subscriptions.Add(-1)
}

// outboundLoop consumes GatewayCommands for one game.
func (b *Bridge) outboundLoop(ctx context.Context, g *game) {
	ch := g.pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			b.deliver(g, []byte(m.Payload))
		}
	}
}

func (b *Bridge) deliver(g *game, payload []byte) {
	var cmd command
	if err := json.Unmarshal(payload, &cmd); err != nil {
		b.log.Warn("q bad gateway command", "channel", b.channelID, "game", g.id)
		return
	}
	targets := cmd.ConnectionIDs
	if cmd.ConnectionID != "" {
		targets = append(targets, cmd.ConnectionID)
	}
	b.mu.Lock()
	socks := make([]Socket, 0, len(targets))
	for _, id := range targets {
		if c, ok := g.conns[id]; ok {
			socks = append(socks, c.sock)
		}
	}
	b.mu.Unlock()
	switch cmd.Op {
	case "send":
		if len(cmd.Message) == 0 {
			return
		}
		for _, s := range socks {
			s.SendRaw(cmd.Message)
		}
		b.stats.Outbound.Add(int64(len(socks)))
	case "drop":
		for _, s := range socks {
			s.Close(1000, "dropped by game")
		}
	default:
		b.log.Warn("q unknown gateway op", "channel", b.channelID, "game", g.id, "op", cmd.Op)
	}
}

// Stop closes every socket and subscription (shutdown or channel gone) and
// refuses later joins.
func (b *Bridge) Stop(code int, reason string) {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		return
	}
	b.stopped = true
	games := make([]*game, 0, len(b.games))
	for _, g := range b.games {
		games = append(games, g)
	}
	b.mu.Unlock()
	for _, g := range games {
		b.mu.Lock()
		conns := make([]*client, 0, len(g.conns))
		for _, c := range g.conns {
			conns = append(conns, c)
		}
		b.mu.Unlock()
		for _, c := range conns {
			c.sock.Close(code, reason)
		}
	}
	b.reg.Forget(b.channelID)
}

// redisErr counts every failure and logs at most one line per op per
// logEvery, so an outage is a counter climbing, not a log flood.
func (b *Bridge) redisErr(op string, err error) {
	b.reg.Counters.RedisErrors.Add(1)
	now := b.now()
	b.mu.Lock()
	if now.Sub(b.logAt[op]) < logEvery {
		b.mu.Unlock()
		return
	}
	b.logAt[op] = now
	b.mu.Unlock()
	b.log.Warn("q redis error", "op", op, "channel", b.channelID, "err", err.Error())
}

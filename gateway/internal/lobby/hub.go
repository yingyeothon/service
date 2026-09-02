// Package lobby implements the `lobby` strategy (`todo/14` §2.3): a
// zone-wide positional relay with gateway-synthesised enter/leave, scoped
// chat, an opaque `event` relay and the party primitive. The gateway knows
// scopes, never semantics.
package lobby

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/yingyeothon/service/gateway/internal/conn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/metrics"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

// Socket is what the hub needs from a connection; `*conn.Conn` satisfies it
// and tests use a recorder. Send is droppable under backpressure (positions:
// newest wins); SendCtl is never dropped (view and chat frames: a client
// that misses one holds a wrong peer set for good).
type Socket interface {
	Send(v any) bool
	SendCtl(v any) bool
	SendError(code, message string)
	Close(code int, reason string)
	Allow() bool
}

// Limits the config does not carry.
const (
	maxZoneLen    = 64
	maxTextLen    = 1024
	maxNameLen    = 64
	maxPayloadLen = 8 << 10
	// badLimit is how many refused messages close a socket (§2.7: decide
	// close-vs-ignore — refuse with an error, close on persistence).
	badLimit = 50
	// inviteCapFactor bounds pending invites to partySizeMax × this.
	inviteCapFactor = 2
	// snapshotOver is the view diff size above which a refresh sends one
	// `snapshot` instead of one `enter`/`leave` per peer: a config change or
	// a crowd arriving must not burst hundreds of control frames into a
	// queue that then has nothing left to drop (`conn.CloseTooSlow`).
	snapshotOver = 32
)

type client struct {
	id     string
	userID string
	sock   Socket
	zone   string
	pos    *Peer
	bad    int
	// cell is the spatial-index bucket of pos (`cellSize` wide).
	cell cellKey
	// visible is the receiver-owned view: every userID this client has been
	// told is present (by `snapshot` or `enter`) and not yet told left. Each
	// `enter`/`leave` is a diff of this set, so a peer that leaves the view
	// box without leaving the zone still produces a `leave` (`todo/26`).
	visible map[string]struct{}
	// resync marks a client whose last snapshot was refused: the next flush
	// re-derives its view even if nothing moved (`todo/28`).
	resync bool
}

// cellKey buckets positions so a view lookup reads 3×3 cells instead of the
// zone. The cell is as wide as the AOI range, so the box around a viewer
// never reaches past its neighbouring cells.
type cellKey struct{ x, y int }

// pendingPos is a position not yet persisted to Redis.
type pendingPos struct {
	zone string
	peer Peer
}

// posPersistEvery bounds how often moved positions are written to Redis.
// They exist for reconnect recovery, which does not need every flush.
const posPersistEvery = time.Second

type party struct {
	id      string
	leader  string
	members []string
	invited map[string]bool
}

type rosterJSON struct {
	ID       string   `json:"id"`
	LeaderID string   `json:"leaderId"`
	Members  []string `json:"members"`
	Invited  []string `json:"invited"`
}

// Hub is one lobby channel.
type Hub struct {
	channelID string
	rdb       *redisx.Client
	log       *slog.Logger
	stats     *metrics.ChannelStats
	reg       *metrics.Registry
	now       func() time.Time
	newID     func() string

	mu     sync.Mutex
	cfg    console.LobbyConfig
	conns  map[string]*client
	byUser map[string]*client
	zones  map[string]map[string]*client
	cells  map[string]map[cellKey]map[string]*client
	dirty  map[string]map[string]Peer
	// pending holds moved positions until the next persist window;
	// lastPersist is when the last batch was written.
	pending     map[string]pendingPos
	lastPersist time.Time
	parties     map[string]*party
	partyOf     map[string]string
	stop        chan struct{}
	stopped     bool
	// after collects Redis writes decided under the lock and run after it:
	// a stalled Redis must never freeze every zone's relay (`persist`).
	// afterMu serialises the drainers so writes run in the order they were
	// decided — a flush's batch and a later leave's write of the same user
	// must not race, or the stale one can land last.
	after   []func()
	afterMu sync.Mutex
	// logAt throttles Redis error logging per op.
	logAt map[string]time.Time
}

// Options builds a Hub.
type Options struct {
	ChannelID string
	Config    console.LobbyConfig
	Redis     *redisx.Client
	Logger    *slog.Logger
	Registry  *metrics.Registry
	Now       func() time.Time
	NewID     func() string
}

// New creates the hub and starts its flush loop.
func New(o Options) *Hub {
	h := &Hub{channelID: o.ChannelID, rdb: o.Redis, log: o.Logger, reg: o.Registry, now: o.Now, newID: o.NewID,
		cfg: normalize(o.Config), conns: map[string]*client{}, byUser: map[string]*client{}, zones: map[string]map[string]*client{},
		cells: map[string]map[cellKey]map[string]*client{}, dirty: map[string]map[string]Peer{}, pending: map[string]pendingPos{},
		parties: map[string]*party{}, partyOf: map[string]string{}, stop: make(chan struct{}), logAt: map[string]time.Time{}}
	if h.log == nil {
		h.log = slog.Default()
	}
	if h.reg == nil {
		h.reg = metrics.New()
	}
	h.stats = h.reg.Channel(o.ChannelID)
	if h.now == nil {
		h.now = time.Now
	}
	if h.newID == nil {
		h.newID = randomID
	}
	h.reg.Gauges.LobbyChannels.Add(1)
	go h.flushLoop()
	return h
}

// normalize fills the defaults the console also applies, so a hub built
// from a partial config (tests, an older console) behaves the same.
func normalize(cfg console.LobbyConfig) console.LobbyConfig {
	if cfg.FlushIntervalMs <= 0 {
		cfg.FlushIntervalMs = 200
	}
	if cfg.AOI != nil {
		if cfg.AOI.Range <= 0 {
			cfg.AOI = nil
		} else {
			a := *cfg.AOI
			if cfg.MaxPeers <= 0 && a.MaxPeers > 0 {
				cfg.MaxPeers = a.MaxPeers
			}
			a.MaxPeers = 0
			cfg.AOI = &a
		}
	}
	if cfg.MaxPeers <= 0 {
		cfg.MaxPeers = 64
	}
	return cfg
}

// Reconfigure applies a refreshed channel config. A changed view rule
// (AOI box or peer cap) re-buckets every position and re-derives every
// view, so clients get the frames that make their peer maps match.
func (h *Hub) Reconfigure(cfg console.LobbyConfig) {
	cfg = normalize(cfg)
	h.mu.Lock()
	defer h.mu.Unlock()
	changed := !sameAOI(h.cfg.AOI, cfg.AOI) || h.cfg.MaxPeers != cfg.MaxPeers
	h.cfg = cfg
	if changed {
		h.rebuildViewsLocked()
	}
}

func sameAOI(a, b *console.LobbyAOI) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Range == b.Range
}

// persist schedules a Redis write for after the lock is released.
func (h *Hub) persist(f func()) { h.after = append(h.after, f) }

// runAfter executes the scheduled writes in order; call with the lock
// released. It holds afterMu across drain and execution, so a concurrent
// caller waits for everything queued before its own writes to finish.
func (h *Hub) runAfter() {
	h.afterMu.Lock()
	defer h.afterMu.Unlock()
	h.mu.Lock()
	fs := h.after
	h.after = nil
	h.mu.Unlock()
	for _, f := range fs {
		f()
	}
}

// Empty reports whether no socket is attached (the server drops idle hubs).
func (h *Hub) Empty() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns) == 0
}

// Stop ends the flush loop and closes every socket.
func (h *Hub) Stop(code int, reason string) {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return
	}
	h.stopped = true
	close(h.stop)
	conns := make([]*client, 0, len(h.conns))
	for _, c := range h.conns {
		conns = append(conns, c)
	}
	parties := len(h.parties)
	h.mu.Unlock()
	for _, c := range conns {
		c.sock.Close(code, reason)
	}
	h.reg.Gauges.LobbyChannels.Add(-1)
	h.reg.Gauges.Parties.Add(-int64(parties))
	h.reg.Forget(h.channelID)
}

// Join attaches a verified user. It replaces an existing socket of the same
// user (§2.6), restores a retained position and party, and sends `hello`.
// The caller then feeds inbound frames to Handle and calls Leave at the end.
//
// It returns false when the hub has been stopped (the server's refresh loop
// drops hubs with no sockets); the caller must fetch a live hub and retry,
// or the socket would sit on a hub with no flush loop that nobody can see.
func (h *Hub) Join(ctx context.Context, connID, userID string, sock Socket) bool {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return false
	}
	if old, ok := h.byUser[userID]; ok {
		h.detachLocked(old, false)
		// Viewers got their `leave`; the successor's entry below (or its
		// first `pos`) is a fresh `enter`.
		old.sock.Close(conn.CloseReplaced, "replaced by a newer connection")
		h.reg.Counters.SessionsReplaced.Add(1)
		// The replaced socket's Leave finds nothing to detach, so account here.
		h.stats.Connections.Add(-1)
	}
	cl := &client{id: connID, userID: userID, sock: sock}
	h.conns[connID] = cl
	h.byUser[userID] = cl
	cfg := h.cfg
	// `hello` goes out before the lock is released: once the client is in
	// `byUser` a whisper or a roster change could otherwise be queued first.
	sock.SendCtl(Hello{Type: THello, UserID: userID, ConnectionID: connID, Tick: cfg.FlushIntervalMs, MapURL: cfg.MapURL,
		Capabilities: capabilities(cfg.Capabilities), Zone: cfg.DefaultZone, PartyID: h.partyOf[userID], AOI: helloAOI(cfg)})
	h.mu.Unlock()
	h.stats.Connections.Add(1)
	// The replaced socket's pending position is written here, in order,
	// before GetPos below reads it back (runAfter serialises drainers).
	h.runAfter()

	if _, err := h.rdb.ClaimSession(ctx, "lobby", h.channelID, userID, connID); err != nil {
		h.redisErr("claim session", err)
	}
	// Restore, outside the lock: Redis round trips must not stall the hub.
	var restored *Peer
	var restoredZone string
	if cfg.Capabilities.Pos {
		if b, err := h.rdb.GetPos(ctx, h.channelID, userID); err != nil {
			h.redisErr("get pos", err)
		} else if b != nil {
			var p struct {
				Zone string  `json:"zone"`
				X    float64 `json:"x"`
				Y    float64 `json:"y"`
				Dir  string  `json:"dir"`
			}
			if json.Unmarshal(b, &p) == nil && p.Zone != "" {
				restored = &Peer{UserID: userID, X: p.X, Y: p.Y, Dir: p.Dir}
				restoredZone = p.Zone
			}
		}
	}
	var restoredParty *party
	if cfg.Capabilities.Party {
		h.mu.Lock()
		_, known := h.partyOf[userID]
		h.mu.Unlock()
		if !known {
			restoredParty = h.loadParty(ctx, userID)
		}
	}

	h.mu.Lock()
	if h.conns[connID] != cl {
		h.mu.Unlock()
		// Replaced while we were talking to Redis: the session key may now
		// name this dead connection, so release it if it does.
		if err := h.rdb.ReleaseSession(ctx, "lobby", h.channelID, userID, connID); err != nil {
			h.redisErr("release session", err)
		}
		return true
	}
	if restoredParty != nil {
		if _, exists := h.parties[restoredParty.id]; !exists {
			h.parties[restoredParty.id] = restoredParty
			for _, m := range restoredParty.members {
				h.partyOf[m] = restoredParty.id
			}
			h.reg.Gauges.Parties.Add(1)
		}
	}
	// The client's own `pos` wins over the retained one: the server starts
	// the read loop after Join returns, so today nothing can have entered a
	// zone here, but a second entry without a leave would double-index it.
	if restored != nil && cl.zone == "" {
		h.enterZoneLocked(cl, restoredZone, *restored)
	}
	if pid := h.partyOf[userID]; pid != "" {
		h.broadcastRosterLocked(h.parties[pid])
	}
	h.mu.Unlock()
	return true
}

// Leave detaches a socket. The retained position and party membership stay
// in Redis so a reconnect resumes them; only an explicit `party.leave` or
// the TTL removes them.
func (h *Hub) Leave(ctx context.Context, connID string) {
	h.mu.Lock()
	cl, ok := h.conns[connID]
	if !ok {
		h.mu.Unlock()
		return
	}
	h.detachLocked(cl, true)
	h.mu.Unlock()
	h.stats.Connections.Add(-1)
	h.runAfter()
	if err := h.rdb.ReleaseSession(ctx, "lobby", h.channelID, cl.userID, connID); err != nil {
		h.redisErr("release session", err)
	}
}

// detachLocked removes a socket. Its zone viewers always get a `leave`
// (a view is a diff of frames, so a replaced socket leaves like any other
// and the successor enters fresh); the party roster is re-broadcast only
// when the user is really gone, since a successor re-sends it on Join.
func (h *Hub) detachLocked(cl *client, announceParty bool) {
	delete(h.conns, cl.id)
	if h.byUser[cl.userID] == cl {
		delete(h.byUser, cl.userID)
	}
	if cl.zone != "" {
		h.leaveZoneLocked(cl)
	}
	// A pending invite dies with the invitee's socket.
	for _, p := range h.parties {
		if p.invited[cl.userID] {
			delete(p.invited, cl.userID)
			if announceParty {
				h.broadcastRosterLocked(p)
			}
		}
	}
	if announceParty {
		if pid := h.partyOf[cl.userID]; pid != "" {
			h.broadcastRosterLocked(h.parties[pid])
		}
	}
}

// Handle processes one inbound frame from connID.
func (h *Hub) Handle(ctx context.Context, connID string, raw []byte) {
	h.mu.Lock()
	cl, ok := h.conns[connID]
	if !ok {
		h.mu.Unlock()
		return
	}
	h.stats.Inbound.Add(1)
	h.reg.Counters.InboundMessages.Add(1)
	if !cl.sock.Allow() {
		h.reg.Counters.RateLimited.Add(1)
		h.refuseLocked(cl, ErrRateLimited, "slow down")
		h.mu.Unlock()
		return
	}
	var in Inbound
	if err := json.Unmarshal(raw, &in); err != nil || in.Type == "" {
		h.reg.Counters.BadMessages.Add(1)
		h.refuseLocked(cl, ErrBadMessage, "expected a JSON object with a string `type`")
		h.mu.Unlock()
		return
	}
	cfg := h.cfg
	switch in.Type {
	case "ping":
		cl.sock.SendCtl(Pong{Type: TPong})
	case TPos:
		h.handlePosLocked(cl, cfg, in)
	case TSay:
		h.handleSayLocked(cl, cfg, in)
	case TEvent:
		h.handleEventLocked(cl, cfg, in)
	case "party.create", "party.invite", "party.accept", "party.decline", "party.leave", "party.list":
		if !cfg.Capabilities.Party {
			h.refuseLocked(cl, ErrCapabilityOff, "party is disabled on this channel")
			break
		}
		h.handlePartyLocked(ctx, cl, cfg, in)
	default:
		h.reg.Counters.BadMessages.Add(1)
		h.refuseLocked(cl, ErrBadMessage, "unknown type")
	}
	h.mu.Unlock()
	h.runAfter()
}

func (h *Hub) refuseLocked(cl *client, code, msg string) {
	cl.sock.SendError(code, msg)
	cl.bad++
	if cl.bad >= badLimit {
		cl.sock.Close(conn.ClosePolicy, "too many refused messages")
	}
}

// --- pos -----------------------------------------------------------------

func (h *Hub) handlePosLocked(cl *client, cfg console.LobbyConfig, in Inbound) {
	if !cfg.Capabilities.Pos {
		h.refuseLocked(cl, ErrCapabilityOff, "pos is disabled on this channel")
		return
	}
	if in.Zone == "" || len(in.Zone) > maxZoneLen || !utf8.ValidString(in.Zone) {
		h.refuseLocked(cl, ErrBadZone, "zone is required")
		return
	}
	if in.X == nil || in.Y == nil || math.IsNaN(*in.X) || math.IsNaN(*in.Y) || math.IsInf(*in.X, 0) || math.IsInf(*in.Y, 0) {
		h.refuseLocked(cl, ErrBadMessage, "x and y are required numbers")
		return
	}
	if len(in.Dir) > 16 {
		h.refuseLocked(cl, ErrBadMessage, "dir too long")
		return
	}
	p := Peer{UserID: cl.userID, X: *in.X, Y: *in.Y, Dir: in.Dir}
	if cl.zone == in.Zone && cl.pos != nil {
		if math.Abs(p.X-cl.pos.X) > cfg.MaxMoveDelta || math.Abs(p.Y-cl.pos.Y) > cfg.MaxMoveDelta {
			h.refuseLocked(cl, ErrMoveTooFar, "movement exceeds maxMoveDelta")
			return
		}
		cl.pos = &p
		h.moveCellLocked(cl)
		h.markDirtyLocked(cl.zone, p)
		return
	}
	// Zone change (or first position): leave-from-old, enter-to-new, from
	// retained state — the decision itself was the game HTTP API's (§2.3).
	if cl.zone != "" {
		h.leaveZoneLocked(cl)
	}
	h.enterZoneLocked(cl, in.Zone, p)
}

func (h *Hub) enterZoneLocked(cl *client, zone string, p Peer) {
	cl.zone = zone
	cl.pos = &p
	peers := h.zones[zone]
	if peers == nil {
		peers = map[string]*client{}
		h.zones[zone] = peers
	}
	peers[cl.userID] = cl
	h.indexLocked(cl)
	// The joiner's first view is the snapshot, never a burst of `enter`.
	h.snapshotLocked(cl)
	// Everyone whose view could contain the joiner learns of it now.
	for _, other := range h.neighboursLocked(cl) {
		h.refreshViewLocked(other)
	}
	h.markDirtyLocked(zone, p)
}

// snapshotLocked sends cl its whole current view as one `snapshot` and
// makes that the view. A snapshot the socket refused (over the outbound
// cap — impossible under the MaxPeers cap, kept as a guard) taught the
// client nothing: the view stays empty and `resync` makes the next flush
// re-derive it, introducing each peer with its own `enter`.
func (h *Hub) snapshotLocked(cl *client) {
	view := h.viewLocked(cl)
	snap := Snapshot{Type: TSnapshot, Zone: cl.zone, Peers: make([]Peer, 0, len(view))}
	visible := make(map[string]struct{}, len(view))
	for _, other := range view {
		snap.Peers = append(snap.Peers, *other.pos)
		visible[other.userID] = struct{}{}
	}
	if cl.sock.SendCtl(snap) {
		cl.visible = visible
		cl.resync = false
	} else {
		cl.visible = map[string]struct{}{}
		cl.resync = true
	}
}

// leaveZoneLocked removes cl from its zone; every viewer holding it gets a
// `leave` and has its view re-derived (a freed slot may admit another).
func (h *Hub) leaveZoneLocked(cl *client) {
	zone := cl.zone
	cl.zone = ""
	cl.visible = nil
	cl.resync = false
	peers := h.zones[zone]
	if peers == nil || peers[cl.userID] != cl {
		// Not the client the zone holds for this user (a successor already
		// took the seat): its dirty entry, its retained position and its
		// viewers all belong to the live one now.
		return
	}
	// A leaving position is persisted at once: the retained value is what a
	// reconnect resumes from, and the persist window must not lose it.
	moved := false
	if d := h.dirty[zone]; d != nil {
		if _, ok := d[cl.userID]; ok {
			moved = true
			delete(d, cl.userID)
		}
	}
	if _, ok := h.pending[cl.userID]; ok {
		moved = true
		delete(h.pending, cl.userID)
	}
	if moved && cl.pos != nil {
		h.persistPosLocked(map[string]pendingPos{cl.userID: {zone: zone, peer: *cl.pos}})
	}
	delete(peers, cl.userID)
	h.unindexLocked(cl, zone)
	if len(peers) == 0 {
		delete(h.zones, zone)
		delete(h.cells, zone)
		delete(h.dirty, zone)
	}
	for _, other := range h.viewersLocked(cl, zone) {
		h.refreshViewLocked(other)
	}
}

// viewersLocked is neighboursLocked plus every client in the zone whose
// view still holds cl: views are derived at flush time, and a peer can move
// out of a viewer's 3×3 cells and leave the zone before the next flush —
// that viewer must still get its `leave`, or the character freezes. zone is
// passed because the caller may already have cleared cl.zone.
func (h *Hub) viewersLocked(cl *client, zone string) []*client {
	out := h.neighboursInLocked(cl, zone)
	if h.cfg.AOI == nil {
		return out
	}
	seen := make(map[*client]struct{}, len(out))
	for _, other := range out {
		seen[other] = struct{}{}
	}
	for _, other := range h.zones[zone] {
		if _, dup := seen[other]; dup || other == cl {
			continue
		}
		if _, sees := other.visible[cl.userID]; sees {
			out = append(out, other)
		}
	}
	return out
}

// --- view ------------------------------------------------------------------

// cellSize is the spatial bucket width: the AOI range, or 1 without AOI
// (the index is kept either way so switching AOI on is a rebucket, not a
// rebuild from scratch).
func (h *Hub) cellSize() float64 {
	if h.cfg.AOI != nil {
		return h.cfg.AOI.Range
	}
	return 1
}

func (h *Hub) cellOf(p *Peer) cellKey {
	size := h.cellSize()
	return cellKey{int(math.Floor(p.X / size)), int(math.Floor(p.Y / size))}
}

func (h *Hub) indexLocked(cl *client) {
	cells := h.cells[cl.zone]
	if cells == nil {
		cells = map[cellKey]map[string]*client{}
		h.cells[cl.zone] = cells
	}
	cl.cell = h.cellOf(cl.pos)
	bucket := cells[cl.cell]
	if bucket == nil {
		bucket = map[string]*client{}
		cells[cl.cell] = bucket
	}
	bucket[cl.userID] = cl
}

func (h *Hub) unindexLocked(cl *client, zone string) {
	cells := h.cells[zone]
	if cells == nil {
		return
	}
	if bucket := cells[cl.cell]; bucket != nil && bucket[cl.userID] == cl {
		delete(bucket, cl.userID)
		if len(bucket) == 0 {
			delete(cells, cl.cell)
		}
	}
}

// moveCellLocked re-buckets cl after a same-zone move.
func (h *Hub) moveCellLocked(cl *client) {
	if next := h.cellOf(cl.pos); next != cl.cell {
		h.unindexLocked(cl, cl.zone)
		h.indexLocked(cl)
	}
}

// neighboursLocked lists every other client whose view could include cl:
// the zone without an AOI box, the 3×3 cells around cl with one.
func (h *Hub) neighboursLocked(cl *client) []*client { return h.neighboursInLocked(cl, cl.zone) }

func (h *Hub) neighboursInLocked(cl *client, zone string) []*client {
	if h.cfg.AOI == nil {
		out := make([]*client, 0, len(h.zones[zone]))
		for _, other := range h.zones[zone] {
			if other != cl {
				out = append(out, other)
			}
		}
		return out
	}
	cells := h.cells[zone]
	var out []*client
	for dx := -1; dx <= 1; dx++ {
		for dy := -1; dy <= 1; dy++ {
			for _, other := range cells[cellKey{cl.cell.x + dx, cl.cell.y + dy}] {
				if other != cl {
					out = append(out, other)
				}
			}
		}
	}
	return out
}

// viewLocked computes who cl can see, sorted by userID: the peers within
// the AOI box (the whole zone without one), nearest first up to MaxPeers
// (ties by userID, so the cut is deterministic). The cap always applies,
// so a snapshot or a pos batch never outgrows the outbound frame cap.
func (h *Hub) viewLocked(cl *client) []*client {
	out := h.neighboursLocked(cl)
	if aoi := h.cfg.AOI; aoi != nil {
		kept := out[:0]
		for _, other := range out {
			if math.Abs(other.pos.X-cl.pos.X) <= aoi.Range && math.Abs(other.pos.Y-cl.pos.Y) <= aoi.Range {
				kept = append(kept, other)
			}
		}
		out = kept
	}
	if len(out) > h.cfg.MaxPeers {
		dist := func(o *client) float64 {
			return math.Max(math.Abs(o.pos.X-cl.pos.X), math.Abs(o.pos.Y-cl.pos.Y))
		}
		sort.Slice(out, func(i, j int) bool {
			di, dj := dist(out[i]), dist(out[j])
			if di != dj {
				return di < dj
			}
			return out[i].userID < out[j].userID
		})
		out = out[:h.cfg.MaxPeers]
	}
	sort.Slice(out, func(i, j int) bool { return out[i].userID < out[j].userID })
	return out
}

// viewIsZoneLocked reports whether cl's view can only change when someone
// enters or leaves its zone: no AOI box and the zone within the cap. Those
// events refresh the view themselves, so a flush can skip it.
func (h *Hub) viewIsZoneLocked(cl *client) bool {
	return h.cfg.AOI == nil && len(h.zones[cl.zone]) <= h.cfg.MaxPeers+1
}

// refreshViewLocked re-derives cl's view and sends the diff: `enter` for
// each peer now in view, `leave` for each that dropped out — or one fresh
// `snapshot` when the diff is large (snapshotOver), so a wholesale change
// costs one control frame instead of hundreds.
func (h *Hub) refreshViewLocked(cl *client) {
	if cl.zone == "" || cl.pos == nil {
		return
	}
	view := h.viewLocked(cl)
	next := make(map[string]struct{}, len(view))
	var enters []*client
	for _, other := range view {
		next[other.userID] = struct{}{}
		if _, had := cl.visible[other.userID]; !had {
			enters = append(enters, other)
		}
	}
	var gone []string
	for id := range cl.visible {
		if _, still := next[id]; !still {
			gone = append(gone, id)
		}
	}
	if len(enters)+len(gone) > snapshotOver {
		h.snapshotLocked(cl)
		return
	}
	// A control frame is never dropped for room; SendCtl only fails for a
	// socket that is already closing, whose view no longer matters.
	for _, other := range enters {
		cl.sock.SendCtl(Enter{Type: TEnter, Zone: cl.zone, Peer: *other.pos})
	}
	sort.Strings(gone)
	for _, id := range gone {
		cl.sock.SendCtl(Leave{Type: TLeave, Zone: cl.zone, UserID: id})
	}
	cl.visible = next
	cl.resync = false
}

// rebuildViewsLocked re-buckets every position and refreshes every view
// after the view rule changed.
func (h *Hub) rebuildViewsLocked() {
	h.cells = map[string]map[cellKey]map[string]*client{}
	for _, peers := range h.zones {
		for _, cl := range peers {
			h.indexLocked(cl)
		}
	}
	for _, peers := range h.zones {
		for _, cl := range peers {
			h.refreshViewLocked(cl)
		}
	}
}

// --- flush -----------------------------------------------------------------

func (h *Hub) markDirtyLocked(zone string, p Peer) {
	d := h.dirty[zone]
	if d == nil {
		d = map[string]Peer{}
		h.dirty[zone] = d
	}
	d[p.UserID] = p
}

func (h *Hub) flushLoop() {
	h.mu.Lock()
	interval := time.Duration(h.cfg.FlushIntervalMs) * time.Millisecond
	h.mu.Unlock()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-t.C:
			h.Flush(context.Background())
			h.mu.Lock()
			if next := time.Duration(h.cfg.FlushIntervalMs) * time.Millisecond; next != interval && next > 0 {
				interval = next
				t.Reset(interval)
			}
			h.mu.Unlock()
		}
	}
}

// Flush sends each client one coalesced `pos` frame with every peer in its
// view that moved since the last flush (the client itself included), after
// re-deriving views so that `enter`/`leave` precede the positions; then
// persists moved positions at most once per posPersistEvery. Exported for
// tests.
//
// The batches are enqueued while the hub lock is held: the lock is the one
// order every peer frame shares, and a batch decided under it but sent
// after it could land behind a `leave` for the same peer (`todo/28`). The
// enqueue is non-blocking, so the lock only pays for the marshal.
func (h *Hub) Flush(ctx context.Context) {
	type delivery struct {
		to    *client
		zone  string
		peers []Peer
	}
	h.mu.Lock()
	started := h.now()
	var out []delivery
	// A client whose snapshot was refused is re-derived even if nothing
	// moved; the dirty loop below would not reach a quiet zone.
	for _, c := range h.conns {
		if c.resync {
			h.refreshViewLocked(c)
		}
	}
	for zone, d := range h.dirty {
		if len(d) == 0 {
			continue
		}
		for _, c := range h.zones[zone] {
			// A move can flip a view (the box, or the nearest-first cut);
			// a zone-wide view within the cap only changes on enter/leave,
			// which already refreshed it.
			if !h.viewIsZoneLocked(c) {
				h.refreshViewLocked(c)
			}
			peers := make([]Peer, 0, len(d))
			for id, p := range d {
				if _, seen := c.visible[id]; seen || id == c.userID {
					peers = append(peers, p)
				}
			}
			if len(peers) == 0 {
				continue
			}
			sort.Slice(peers, func(i, j int) bool { return peers[i].UserID < peers[j].UserID })
			out = append(out, delivery{to: c, zone: zone, peers: peers})
		}
		for id, p := range d {
			h.pending[id] = pendingPos{zone: zone, peer: p}
		}
		delete(h.dirty, zone)
	}
	if len(h.pending) > 0 {
		if h.lastPersist.IsZero() || started.Sub(h.lastPersist) >= posPersistEvery {
			h.lastPersist = started
			batch := h.pending
			h.pending = map[string]pendingPos{}
			h.persistPosLocked(batch)
		}
	}
	// Recipients with the same peer list share one marshalled frame: the
	// whole zone without AOI, a cell's worth of viewers with it. Keyed per
	// zone first, so a zone name containing the separator cannot alias.
	shared := map[string]map[string][]byte{}
	var kb strings.Builder
	for _, dl := range out {
		kb.Reset()
		for _, p := range dl.peers {
			kb.WriteString(p.UserID)
			kb.WriteByte(0)
		}
		key := kb.String()
		if shared[dl.zone] == nil {
			shared[dl.zone] = map[string][]byte{}
		}
		raw, ok := shared[dl.zone][key]
		if !ok {
			var err error
			if raw, err = json.Marshal(PosBatch{Type: TPos, Zone: dl.zone, Peers: dl.peers}); err != nil {
				continue
			}
			shared[dl.zone][key] = raw
		}
		if s, ok := dl.to.sock.(interface{ SendRaw([]byte) bool }); ok {
			s.SendRaw(raw)
		} else {
			dl.to.sock.Send(PosBatch{Type: TPos, Zone: dl.zone, Peers: dl.peers})
		}
	}
	h.reg.Gauges.RecordFlushHold(h.now().Sub(started).Microseconds())
	h.mu.Unlock()
	h.runAfter()
}

// persistPosLocked schedules one batched write of the given positions.
func (h *Hub) persistPosLocked(batch map[string]pendingPos) {
	values := make(map[string][]byte, len(batch))
	for id, pp := range batch {
		v, _ := json.Marshal(struct {
			Zone string  `json:"zone"`
			X    float64 `json:"x"`
			Y    float64 `json:"y"`
			Dir  string  `json:"dir,omitempty"`
		}{pp.zone, pp.peer.X, pp.peer.Y, pp.peer.Dir})
		values[id] = v
	}
	h.persist(func() {
		if err := h.rdb.SetPosBatch(context.Background(), h.channelID, values); err != nil {
			h.redisErr("set pos", err)
		}
	})
}

// --- say / event -----------------------------------------------------------

// scopeTargets resolves a scope to the sockets that receive it, sender
// included (a client sees its own message echoed, like topic).
func (h *Hub) scopeTargetsLocked(cl *client, scope, to string) ([]*client, string, bool) {
	switch scope {
	case "zone":
		if cl.zone == "" {
			return nil, ErrBadZone, false
		}
		out := make([]*client, 0, len(h.zones[cl.zone]))
		for _, c := range h.zones[cl.zone] {
			// Zone chat reaches whoever has the speaker in view (plus the
			// speaker): views are receiver-owned, so this is the same rule
			// as `pos` (`todo/26` Q6) — never the zone map.
			if _, sees := c.visible[cl.userID]; c == cl || sees {
				out = append(out, c)
			}
		}
		return out, "", true
	case "party":
		pid := h.partyOf[cl.userID]
		if pid == "" {
			return nil, ErrNoParty, false
		}
		p := h.parties[pid]
		var out []*client
		for _, m := range p.members {
			if c, ok := h.byUser[m]; ok {
				out = append(out, c)
			}
		}
		return out, "", true
	case "user":
		// Routed by userId from the connection table, never through the
		// positional index: two players in different zones can whisper.
		target, ok := h.byUser[to]
		if !ok || to == "" {
			return nil, ErrUnknownUser, false
		}
		if target == cl {
			return []*client{cl}, "", true
		}
		return []*client{target, cl}, "", true
	}
	return nil, ErrBadScope, false
}

func (h *Hub) handleSayLocked(cl *client, cfg console.LobbyConfig, in Inbound) {
	if !cfg.Capabilities.AllowsSay(in.Scope) {
		if in.Scope == "zone" || in.Scope == "party" || in.Scope == "user" {
			h.refuseLocked(cl, ErrCapabilityOff, "say."+in.Scope+" is disabled on this channel")
		} else {
			h.refuseLocked(cl, ErrBadScope, "scope must be zone|party|user")
		}
		return
	}
	if in.Text == "" || len(in.Text) > maxTextLen || !utf8.ValidString(in.Text) {
		h.refuseLocked(cl, ErrTooLong, "text must be 1..1024 bytes")
		return
	}
	targets, code, ok := h.scopeTargetsLocked(cl, in.Scope, in.To)
	if !ok {
		h.refuseLocked(cl, code, "cannot route to that scope")
		return
	}
	frame := Say{Type: TSay, From: cl.userID, Scope: in.Scope, To: in.To, Text: in.Text}
	if in.Scope != "user" {
		frame.To = ""
	}
	for _, c := range targets {
		c.sock.SendCtl(frame)
	}
}

func (h *Hub) handleEventLocked(cl *client, cfg console.LobbyConfig, in Inbound) {
	if !cfg.Capabilities.Event {
		h.refuseLocked(cl, ErrCapabilityOff, "event is disabled on this channel")
		return
	}
	if in.Name == "" || len(in.Name) > maxNameLen || !utf8.ValidString(in.Name) {
		h.refuseLocked(cl, ErrBadMessage, "name must be 1..64 bytes")
		return
	}
	if len(in.Payload) > maxPayloadLen {
		h.refuseLocked(cl, ErrTooLong, "payload over 8 KB")
		return
	}
	targets, code, ok := h.scopeTargetsLocked(cl, in.Scope, in.To)
	if !ok {
		h.refuseLocked(cl, code, "cannot route to that scope")
		return
	}
	frame := Event{Type: TEvent, From: cl.userID, Scope: in.Scope, Name: in.Name, Payload: in.Payload}
	if in.Scope == "user" {
		frame.To = in.To
	}
	for _, c := range targets {
		c.sock.SendCtl(frame)
	}
}

// --- party ---------------------------------------------------------------

func (h *Hub) handlePartyLocked(ctx context.Context, cl *client, cfg console.LobbyConfig, in Inbound) {
	switch in.Type {
	case "party.create":
		if h.partyOf[cl.userID] != "" {
			h.refuseLocked(cl, ErrInParty, "leave your party first")
			return
		}
		p := &party{id: "pty_" + h.newID(), leader: cl.userID, members: []string{cl.userID}, invited: map[string]bool{}}
		h.parties[p.id] = p
		h.partyOf[cl.userID] = p.id
		h.reg.Gauges.Parties.Add(1)
		h.persistParty(ctx, p, nil)
		h.broadcastRosterLocked(p)
	case "party.invite":
		p := h.parties[h.partyOf[cl.userID]]
		if p == nil {
			h.refuseLocked(cl, ErrNoParty, "create a party first")
			return
		}
		if p.leader != cl.userID {
			h.refuseLocked(cl, ErrNotLeader, "only the leader invites")
			return
		}
		target, online := h.byUser[in.UserID]
		if !online {
			h.refuseLocked(cl, ErrUnknownUser, "that user is not online")
			return
		}
		if h.partyOf[in.UserID] != "" {
			h.refuseLocked(cl, ErrInParty, "that user is already in a party")
			return
		}
		if len(p.members) >= cfg.PartySizeMax {
			h.refuseLocked(cl, ErrPartyFull, "party is full")
			return
		}
		if p.invited[in.UserID] {
			// Already pending: no second frame, so a leader cannot spam.
			cl.sock.SendCtl(h.rosterLocked(p))
			return
		}
		if len(p.invited) >= cfg.PartySizeMax*inviteCapFactor {
			h.refuseLocked(cl, ErrPartyFull, "too many pending invites")
			return
		}
		p.invited[in.UserID] = true
		target.sock.SendCtl(Invite{Type: TInvite, PartyID: p.id, From: cl.userID})
		h.broadcastRosterLocked(p)
	case "party.accept":
		p := h.parties[in.PartyID]
		if p == nil {
			h.refuseLocked(cl, ErrUnknownParty, "no such party")
			return
		}
		if !p.invited[cl.userID] {
			h.refuseLocked(cl, ErrNotInvited, "you were not invited")
			return
		}
		if h.partyOf[cl.userID] != "" {
			h.refuseLocked(cl, ErrInParty, "leave your party first")
			return
		}
		if len(p.members) >= cfg.PartySizeMax {
			delete(p.invited, cl.userID)
			h.refuseLocked(cl, ErrPartyFull, "party is full")
			return
		}
		delete(p.invited, cl.userID)
		p.members = append(p.members, cl.userID)
		h.partyOf[cl.userID] = p.id
		h.persistParty(ctx, p, nil)
		h.broadcastRosterLocked(p)
	case "party.decline":
		p := h.parties[in.PartyID]
		if p == nil || !p.invited[cl.userID] {
			h.refuseLocked(cl, ErrNotInvited, "no pending invite")
			return
		}
		delete(p.invited, cl.userID)
		if leader, ok := h.byUser[p.leader]; ok {
			leader.sock.SendCtl(Declined{Type: TDeclined, PartyID: p.id, UserID: cl.userID})
		}
		h.broadcastRosterLocked(p)
	case "party.leave":
		pid := h.partyOf[cl.userID]
		p := h.parties[pid]
		if p == nil {
			h.refuseLocked(cl, ErrNoParty, "you are in no party")
			return
		}
		h.removeMemberLocked(ctx, p, cl.userID)
		cl.sock.SendCtl(Roster{Type: TParty, PartyID: "", Members: []Member{}})
	case "party.list":
		p := h.parties[h.partyOf[cl.userID]]
		if p == nil {
			cl.sock.SendCtl(Roster{Type: TParty, PartyID: "", Members: []Member{}})
			return
		}
		cl.sock.SendCtl(h.rosterLocked(p))
	}
}

func (h *Hub) removeMemberLocked(ctx context.Context, p *party, userID string) {
	kept := p.members[:0]
	for _, m := range p.members {
		if m != userID {
			kept = append(kept, m)
		}
	}
	p.members = kept
	delete(h.partyOf, userID)
	if len(p.members) == 0 {
		delete(h.parties, p.id)
		h.reg.Gauges.Parties.Add(-1)
		id := p.id
		h.persist(func() {
			if err := h.rdb.DelParty(ctx, h.channelID, id, []string{userID}); err != nil {
				h.redisErr("del party", err)
			}
		})
		return
	}
	if p.leader == userID {
		p.leader = p.members[0]
	}
	h.persistParty(ctx, p, []string{userID})
	h.broadcastRosterLocked(p)
}

func (h *Hub) rosterLocked(p *party) Roster {
	r := Roster{Type: TParty, PartyID: p.id, LeaderID: p.leader, Members: make([]Member, 0, len(p.members)), Max: h.cfg.PartySizeMax}
	for _, m := range p.members {
		_, online := h.byUser[m]
		r.Members = append(r.Members, Member{UserID: m, Online: online})
	}
	for u := range p.invited {
		r.Invited = append(r.Invited, u)
	}
	sort.Strings(r.Invited)
	return r
}

func (h *Hub) broadcastRosterLocked(p *party) {
	if p == nil {
		return
	}
	r := h.rosterLocked(p)
	for _, m := range p.members {
		if c, ok := h.byUser[m]; ok {
			c.sock.SendCtl(r)
		}
	}
}

// persistParty mirrors the roster to Redis so the game's entry API reads a
// roster it can trust (§2.3). `removed` members lose their reverse index.
// The snapshot is taken under the lock; the write runs after it.
func (h *Hub) persistParty(ctx context.Context, p *party, removed []string) {
	invited := make([]string, 0, len(p.invited))
	for u := range p.invited {
		invited = append(invited, u)
	}
	sort.Strings(invited)
	members := append([]string(nil), p.members...)
	b, _ := json.Marshal(rosterJSON{ID: p.id, LeaderID: p.leader, Members: members, Invited: invited})
	id := p.id
	h.persist(func() {
		if err := h.rdb.SetParty(ctx, h.channelID, id, b, members); err != nil {
			h.redisErr("set party", err)
		}
		for _, u := range removed {
			if err := h.rdb.DelPartyOf(ctx, h.channelID, u); err != nil {
				h.redisErr("del partyOf", err)
			}
		}
	})
}

// loadParty restores a roster after a gateway restart.
func (h *Hub) loadParty(ctx context.Context, userID string) *party {
	pid, err := h.rdb.PartyOf(ctx, h.channelID, userID)
	if err != nil {
		h.redisErr("partyOf", err)
		return nil
	}
	if pid == "" {
		return nil
	}
	b, err := h.rdb.GetParty(ctx, h.channelID, pid)
	if err != nil {
		h.redisErr("get party", err)
		return nil
	}
	if b == nil {
		return nil
	}
	var r rosterJSON
	if json.Unmarshal(b, &r) != nil || r.ID != pid || len(r.Members) == 0 {
		return nil
	}
	p := &party{id: r.ID, leader: r.LeaderID, members: r.Members, invited: map[string]bool{}}
	for _, u := range r.Invited {
		p.invited[u] = true
	}
	return p
}

// --- helpers -------------------------------------------------------------

// redisErr counts every failure and logs at most one line per op per
// logEvery, so a Redis outage is a counter climbing, not a log flood.
func (h *Hub) redisErr(op string, err error) {
	h.reg.Counters.RedisErrors.Add(1)
	now := h.now()
	h.mu.Lock()
	last := h.logAt[op]
	if now.Sub(last) < logEvery {
		h.mu.Unlock()
		return
	}
	h.logAt[op] = now
	h.mu.Unlock()
	h.log.Warn("lobby redis error", "op", op, "channel", h.channelID, "err", err.Error())
}

// logEvery is the per-op log throttle for Redis errors.
const logEvery = 5 * time.Second

// helloAOI is the view rule as `hello` states it: the cap always, the box
// only when the channel has one.
func helloAOI(cfg console.LobbyConfig) *AOI {
	out := &AOI{MaxPeers: cfg.MaxPeers}
	if cfg.AOI != nil {
		out.Range = cfg.AOI.Range
	}
	return out
}

func capabilities(c console.Capabilities) Capabilities {
	say := make([]string, 0, len(c.Say))
	for _, s := range c.Say {
		say = append(say, string(s))
	}
	return Capabilities{Pos: c.Pos, Say: say, Party: c.Party, Event: c.Event, Debug: c.Debug}
}

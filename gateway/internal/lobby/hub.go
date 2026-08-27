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
	"sync"
	"time"
	"unicode/utf8"

	"github.com/yingyeothon/service/gateway/internal/conn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/metrics"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

// Socket is what the hub needs from a connection; `*conn.Conn` satisfies it
// and tests use a recorder.
type Socket interface {
	Send(v any) bool
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
)

type client struct {
	id     string
	userID string
	sock   Socket
	zone   string
	pos    *Peer
	bad    int
}

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

	mu      sync.Mutex
	cfg     console.LobbyConfig
	conns   map[string]*client
	byUser  map[string]*client
	zones   map[string]map[string]*client
	dirty   map[string]map[string]Peer
	parties map[string]*party
	partyOf map[string]string
	stop    chan struct{}
	stopped bool
	// after collects Redis writes decided under the lock and run after it:
	// a stalled Redis must never freeze every zone's relay (`persist`).
	after []func()
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
		cfg: o.Config, conns: map[string]*client{}, byUser: map[string]*client{}, zones: map[string]map[string]*client{},
		dirty: map[string]map[string]Peer{}, parties: map[string]*party{}, partyOf: map[string]string{}, stop: make(chan struct{}), logAt: map[string]time.Time{}}
	if h.cfg.FlushIntervalMs <= 0 {
		h.cfg.FlushIntervalMs = 200
	}
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

// Reconfigure applies a refreshed channel config.
func (h *Hub) Reconfigure(cfg console.LobbyConfig) {
	if cfg.FlushIntervalMs <= 0 {
		cfg.FlushIntervalMs = 200
	}
	h.mu.Lock()
	h.cfg = cfg
	h.mu.Unlock()
}

// persist schedules a Redis write for after the lock is released.
func (h *Hub) persist(f func()) { h.after = append(h.after, f) }

// runAfter executes the scheduled writes; call with the lock released.
func (h *Hub) runAfter() {
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
	sock.Send(Hello{Type: THello, UserID: userID, ConnectionID: connID, Tick: cfg.FlushIntervalMs, MapURL: cfg.MapURL,
		Capabilities: capabilities(cfg.Capabilities), Zone: cfg.DefaultZone, PartyID: h.partyOf[userID]})
	h.mu.Unlock()
	h.stats.Connections.Add(1)

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
	if restored != nil {
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

func (h *Hub) detachLocked(cl *client, announce bool) {
	delete(h.conns, cl.id)
	if h.byUser[cl.userID] == cl {
		delete(h.byUser, cl.userID)
	}
	if cl.zone != "" {
		h.leaveZoneLocked(cl, announce)
	}
	// A pending invite dies with the invitee's socket.
	for _, p := range h.parties {
		if p.invited[cl.userID] {
			delete(p.invited, cl.userID)
			if announce {
				h.broadcastRosterLocked(p)
			}
		}
	}
	if announce {
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
		cl.sock.Send(Pong{Type: TPong})
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
		h.markDirtyLocked(cl.zone, p)
		return
	}
	// Zone change (or first position): leave-from-old, enter-to-new, from
	// retained state — the decision itself was the game HTTP API's (§2.3).
	if cl.zone != "" {
		h.leaveZoneLocked(cl, true)
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
	snap := Snapshot{Type: TSnapshot, Zone: zone, Peers: make([]Peer, 0, len(peers))}
	enter := Enter{Type: TEnter, Zone: zone, Peer: p}
	for _, other := range peers {
		if other.pos != nil {
			snap.Peers = append(snap.Peers, *other.pos)
		}
		other.sock.Send(enter)
	}
	sort.Slice(snap.Peers, func(i, j int) bool { return snap.Peers[i].UserID < snap.Peers[j].UserID })
	peers[cl.userID] = cl
	cl.sock.Send(snap)
	h.markDirtyLocked(zone, p)
}

func (h *Hub) leaveZoneLocked(cl *client, announce bool) {
	zone := cl.zone
	peers := h.zones[zone]
	if peers != nil && peers[cl.userID] == cl {
		delete(peers, cl.userID)
		if len(peers) == 0 {
			delete(h.zones, zone)
			delete(h.dirty, zone)
		}
	}
	if d := h.dirty[zone]; d != nil {
		delete(d, cl.userID)
	}
	if announce && peers != nil {
		leave := Leave{Type: TLeave, Zone: zone, UserID: cl.userID}
		for _, other := range peers {
			other.sock.Send(leave)
		}
	}
	cl.zone = ""
}

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

// Flush sends one coalesced `pos` frame per zone with every peer that moved
// since the last flush, and persists those positions. Exported for tests.
func (h *Hub) Flush(ctx context.Context) {
	type zoneBatch struct {
		zone  string
		peers []Peer
		to    []*client
	}
	h.mu.Lock()
	batches := make([]zoneBatch, 0, len(h.dirty))
	for zone, d := range h.dirty {
		if len(d) == 0 {
			continue
		}
		b := zoneBatch{zone: zone, peers: make([]Peer, 0, len(d))}
		for _, p := range d {
			b.peers = append(b.peers, p)
		}
		sort.Slice(b.peers, func(i, j int) bool { return b.peers[i].UserID < b.peers[j].UserID })
		for _, c := range h.zones[zone] {
			b.to = append(b.to, c)
		}
		batches = append(batches, b)
		delete(h.dirty, zone)
	}
	h.mu.Unlock()
	for _, b := range batches {
		frame := PosBatch{Type: TPos, Zone: b.zone, Peers: b.peers}
		raw, err := json.Marshal(frame)
		if err != nil {
			continue
		}
		for _, c := range b.to {
			if s, ok := c.sock.(interface{ SendRaw([]byte) bool }); ok {
				s.SendRaw(raw)
			} else {
				c.sock.Send(frame)
			}
		}
		var failed error
		for _, p := range b.peers {
			v, _ := json.Marshal(struct {
				Zone string  `json:"zone"`
				X    float64 `json:"x"`
				Y    float64 `json:"y"`
				Dir  string  `json:"dir,omitempty"`
			}{b.zone, p.X, p.Y, p.Dir})
			if err := h.rdb.SetPos(ctx, h.channelID, p.UserID, v); err != nil {
				failed = err
			}
		}
		if failed != nil {
			h.redisErr("set pos", failed)
		}
	}
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
			out = append(out, c)
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
		c.sock.Send(frame)
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
		c.sock.Send(frame)
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
			cl.sock.Send(h.rosterLocked(p))
			return
		}
		if len(p.invited) >= cfg.PartySizeMax*inviteCapFactor {
			h.refuseLocked(cl, ErrPartyFull, "too many pending invites")
			return
		}
		p.invited[in.UserID] = true
		target.sock.Send(Invite{Type: TInvite, PartyID: p.id, From: cl.userID})
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
			leader.sock.Send(Declined{Type: TDeclined, PartyID: p.id, UserID: cl.userID})
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
		cl.sock.Send(Roster{Type: TParty, PartyID: "", Members: []Member{}})
	case "party.list":
		p := h.parties[h.partyOf[cl.userID]]
		if p == nil {
			cl.sock.Send(Roster{Type: TParty, PartyID: "", Members: []Member{}})
			return
		}
		cl.sock.Send(h.rosterLocked(p))
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
			c.sock.Send(r)
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

func capabilities(c console.Capabilities) Capabilities {
	say := make([]string, 0, len(c.Say))
	for _, s := range c.Say {
		say = append(say, string(s))
	}
	return Capabilities{Pos: c.Pos, Say: say, Party: c.Party, Event: c.Event, Debug: c.Debug}
}

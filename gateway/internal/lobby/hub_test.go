package lobby

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

type rec struct {
	mu     sync.Mutex
	frames []map[string]any
	closed int
	reason string
	allow  bool
}

func newRec() *rec { return &rec{allow: true} }

func (r *rec) Send(v any) bool {
	b, _ := json.Marshal(v)
	return r.SendRaw(b)
}
func (r *rec) SendRaw(b []byte) bool {
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	r.mu.Lock()
	r.frames = append(r.frames, m)
	r.mu.Unlock()
	return true
}
func (r *rec) SendError(code, msg string) {
	r.Send(map[string]string{"type": "error", "code": code, "message": msg})
}
func (r *rec) Close(code int, reason string) {
	r.mu.Lock()
	r.closed, r.reason = code, reason
	r.mu.Unlock()
}
func (r *rec) Allow() bool { return r.allow }

func (r *rec) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.frames))
	for _, f := range r.frames {
		t, _ := f["type"].(string)
		if t == "error" {
			t = "error:" + f["code"].(string)
		}
		out = append(out, t)
	}
	return out
}
func (r *rec) last() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.frames) == 0 {
		return nil
	}
	return r.frames[len(r.frames)-1]
}
func (r *rec) find(t string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.frames) - 1; i >= 0; i-- {
		if r.frames[i]["type"] == t {
			return r.frames[i]
		}
	}
	return nil
}
func (r *rec) reset() { r.mu.Lock(); r.frames = nil; r.mu.Unlock() }

func cfg() console.LobbyConfig {
	return console.LobbyConfig{AuthChannelID: "ch_auth",
		Capabilities:    console.Capabilities{Pos: true, Say: []console.SayScope{"zone", "party", "user"}, Party: true, Event: true},
		FlushIntervalMs: 200, MaxMoveDelta: 3, RateLimit: 20, PartySizeMax: 2, DefaultZone: "Zone001", MapURL: "https://d.example.com/m.json"}
}

func newHub(t *testing.T, c console.LobbyConfig) (*Hub, *miniredis.Miniredis, *redisx.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	rx := redisx.Wrap(rdb, "test")
	n := 0
	h := New(Options{ChannelID: "ch_l", Config: c, Redis: rx, NewID: func() string { n++; return fmt.Sprintf("id%d", n) }})
	t.Cleanup(func() { h.Stop(1001, "test") })
	return h, mr, rx
}

func send(h *Hub, id string, v any) {
	b, _ := json.Marshal(v)
	h.Handle(context.Background(), id, b)
}

func TestHelloEnterLeaveAndFlush(t *testing.T) {
	h, mr, _ := newHub(t, cfg())
	ctx := context.Background()
	a, b := newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	hello := a.last()
	if hello["type"] != "hello" || hello["userId"] != "ua" || hello["zone"] != "Zone001" || hello["tick"].(float64) != 200 || hello["mapUrl"] != "https://d.example.com/m.json" {
		t.Fatalf("hello: %v", hello)
	}
	if caps := hello["capabilities"].(map[string]any); caps["pos"] != true || len(caps["say"].([]any)) != 3 {
		t.Fatalf("capabilities: %v", caps)
	}
	if !mr.Exists("gateway:test:session:lobby:ch_l:ua") {
		t.Fatal("session not claimed")
	}
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone001", "x": 1, "y": 2, "dir": "n"})
	if snap := a.find("snapshot"); snap == nil || len(snap["peers"].([]any)) != 0 {
		t.Fatalf("first pos should yield an empty snapshot: %v", a.types())
	}
	h.Join(ctx, "i:b", "ub", b)
	send(h, "i:b", map[string]any{"type": "pos", "zone": "Zone001", "x": 5, "y": 5})
	if snap := b.find("snapshot"); snap == nil || len(snap["peers"].([]any)) != 1 || snap["peers"].([]any)[0].(map[string]any)["userId"] != "ua" {
		t.Fatalf("newcomer snapshot: %v", snap)
	}
	if e := a.find("enter"); e == nil || e["userId"] != "ub" || e["x"].(float64) != 5 {
		t.Fatalf("enter not announced: %v", a.types())
	}
	a.reset()
	b.reset()
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone001", "x": 2, "y": 2})
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone001", "x": 3, "y": 2})
	if len(b.types()) != 0 {
		t.Fatalf("pos relayed before flush: %v", b.types())
	}
	h.Flush(ctx)
	pb := b.find("pos")
	if pb == nil || len(pb["peers"].([]any)) != 2 {
		t.Fatalf("coalesced batch: %v", pb)
	}
	for _, p := range pb["peers"].([]any) {
		if p.(map[string]any)["userId"] == "ua" && p.(map[string]any)["x"].(float64) != 3 {
			t.Fatal("batch does not carry the newest position")
		}
	}
	if got, _ := mr.Get("gateway:test:pos:ch_l:ua"); !strings.Contains(got, `"x":3`) {
		t.Fatalf("pos not persisted: %s", got)
	}
	h.Flush(ctx)
	if len(b.types()) != 1 {
		t.Fatal("empty flush sent a frame")
	}
	// Too far.
	a.reset()
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone001", "x": 30, "y": 2})
	if a.types()[0] != "error:move_too_far" {
		t.Fatalf("delta cap: %v", a.types())
	}
	// Zone change: leave old, enter new.
	b.reset()
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone002", "x": 0, "y": 0})
	if l := b.find("leave"); l == nil || l["userId"] != "ua" || l["zone"] != "Zone001" {
		t.Fatalf("zone change leave: %v", b.types())
	}
	// Disconnect announces leave and releases the session; position stays.
	b.reset()
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Zone001", "x": 0, "y": 0})
	h.Leave(ctx, "i:a")
	if l := b.find("leave"); l == nil || l["userId"] != "ua" {
		t.Fatalf("disconnect leave: %v", b.types())
	}
	if mr.Exists("gateway:test:session:lobby:ch_l:ua") || !mr.Exists("gateway:test:pos:ch_l:ua") {
		t.Fatal("session should be released and pos retained")
	}
	// Reconnect restores the retained position and re-enters the zone.
	a2 := newRec()
	b.reset()
	h.Join(ctx, "i:a2", "ua", a2)
	if a2.find("snapshot") == nil || b.find("enter") == nil {
		t.Fatalf("restore: a2=%v b=%v", a2.types(), b.types())
	}
}

func TestReplaceSessionAndCapabilityOff(t *testing.T) {
	c := cfg()
	c.Capabilities.Pos = false
	c.Capabilities.Say = []console.SayScope{"user"}
	c.Capabilities.Party = false
	h, _, _ := newHub(t, c)
	ctx := context.Background()
	a1, a2 := newRec(), newRec()
	h.Join(ctx, "i:1", "ua", a1)
	h.Join(ctx, "i:2", "ua", a2)
	if a1.closed != 4000 {
		t.Fatalf("old socket not replaced: %d", a1.closed)
	}
	h.Leave(ctx, "i:1")
	if h.stats.Connections.Load() != 1 {
		t.Fatalf("connection stat after replace: %d", h.stats.Connections.Load())
	}
	send(h, "i:1", map[string]any{"type": "ping"})
	if len(a1.types()) != 1 {
		t.Fatal("replaced socket still handled")
	}
	send(h, "i:2", map[string]any{"type": "pos", "zone": "z", "x": 0, "y": 0})
	send(h, "i:2", map[string]any{"type": "say", "scope": "zone", "text": "hi"})
	send(h, "i:2", map[string]any{"type": "party.create"})
	send(h, "i:2", map[string]any{"type": "say", "scope": "bogus", "text": "hi"})
	send(h, "i:2", map[string]any{"type": "nope"})
	send(h, "i:2", []int{1})
	send(h, "i:2", map[string]any{"type": "ping"})
	want := []string{"hello", "error:capability_off", "error:capability_off", "error:capability_off", "error:bad_scope", "error:bad_message", "error:bad_message", "pong"}
	if got := a2.types(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v", got)
	}
	a2.allow = false
	send(h, "i:2", map[string]any{"type": "ping"})
	if a2.last()["code"] != "rate_limited" {
		t.Fatal("rate limit not surfaced")
	}
	a2.allow = true
	for i := 0; i < badLimit; i++ {
		send(h, "i:2", map[string]any{"type": "nope"})
	}
	if a2.closed != 4003 {
		t.Fatalf("persistent abuse not closed: %d", a2.closed)
	}
}

func TestSayAndEventScopes(t *testing.T) {
	h, _, _ := newHub(t, cfg())
	ctx := context.Background()
	a, b, c := newRec(), newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	h.Join(ctx, "i:b", "ub", b)
	h.Join(ctx, "i:c", "uc", c)
	send(h, "i:a", map[string]any{"type": "pos", "zone": "Z", "x": 0, "y": 0})
	send(h, "i:b", map[string]any{"type": "pos", "zone": "Z", "x": 0, "y": 0})
	send(h, "i:c", map[string]any{"type": "pos", "zone": "Other", "x": 0, "y": 0})
	a.reset()
	b.reset()
	c.reset()
	send(h, "i:a", map[string]any{"type": "say", "scope": "zone", "text": "zone hi"})
	if a.find("say") == nil || b.find("say") == nil || c.find("say") != nil {
		t.Fatalf("zone say: a=%v b=%v c=%v", a.types(), b.types(), c.types())
	}
	if s := b.find("say"); s["from"] != "ua" || s["text"] != "zone hi" || s["to"] != nil {
		t.Fatalf("say frame: %v", s)
	}
	// user scope crosses zones and echoes to the sender.
	a.reset()
	c.reset()
	send(h, "i:a", map[string]any{"type": "say", "scope": "user", "to": "uc", "text": "psst"})
	if s := c.find("say"); s == nil || s["to"] != "uc" || a.find("say") == nil {
		t.Fatalf("user say: c=%v a=%v", c.types(), a.types())
	}
	send(h, "i:a", map[string]any{"type": "say", "scope": "user", "to": "nobody", "text": "x"})
	if a.last()["code"] != "unknown_user" {
		t.Fatalf("unknown user: %v", a.last())
	}
	send(h, "i:a", map[string]any{"type": "say", "scope": "zone", "text": strings.Repeat("x", maxTextLen+1)})
	if a.last()["code"] != "too_long" {
		t.Fatal("text cap")
	}
	send(h, "i:a", map[string]any{"type": "say", "scope": "party", "text": "x"})
	if a.last()["code"] != "no_party" {
		t.Fatal("party scope without party")
	}
	// event: payload forwarded unread, name required.
	b.reset()
	send(h, "i:a", map[string]any{"type": "event", "scope": "zone", "name": "emote", "payload": map[string]any{"k": []int{1, 2}}})
	ev := b.find("event")
	if ev == nil || ev["name"] != "emote" || ev["from"] != "ua" {
		t.Fatalf("event: %v", ev)
	}
	if pl, _ := json.Marshal(ev["payload"]); string(pl) != `{"k":[1,2]}` {
		t.Fatalf("payload altered: %s", pl)
	}
	send(h, "i:a", map[string]any{"type": "event", "scope": "zone", "payload": 1})
	if a.last()["code"] != "bad_message" {
		t.Fatal("event without name")
	}
	send(h, "i:a", map[string]any{"type": "event", "scope": "zone", "name": "big", "payload": strings.Repeat("p", maxPayloadLen)})
	if a.last()["code"] != "too_long" {
		t.Fatal("payload cap")
	}
}

func TestPartyLifecycle(t *testing.T) {
	h, mr, rx := newHub(t, cfg())
	ctx := context.Background()
	a, b, c := newRec(), newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	h.Join(ctx, "i:b", "ub", b)
	h.Join(ctx, "i:c", "uc", c)
	send(h, "i:b", map[string]any{"type": "party.invite", "userId": "ua"})
	if b.last()["code"] != "no_party" {
		t.Fatal("invite without party")
	}
	send(h, "i:a", map[string]any{"type": "party.create"})
	r := a.find("party")
	if r == nil || r["partyId"] != "pty_id1" || r["leaderId"] != "ua" || len(r["members"].([]any)) != 1 || r["max"].(float64) != 2 {
		t.Fatalf("create roster: %v", r)
	}
	send(h, "i:a", map[string]any{"type": "party.create"})
	if a.last()["code"] != "already_in_party" {
		t.Fatal("double create")
	}
	send(h, "i:a", map[string]any{"type": "party.invite", "userId": "ghost"})
	if a.last()["code"] != "unknown_user" {
		t.Fatal("invite offline")
	}
	send(h, "i:a", map[string]any{"type": "party.invite", "userId": "ub"})
	if inv := b.find("party.invite"); inv == nil || inv["partyId"] != "pty_id1" || inv["from"] != "ua" {
		t.Fatalf("invite: %v", b.types())
	}
	send(h, "i:c", map[string]any{"type": "party.accept", "partyId": "pty_id1"})
	if c.last()["code"] != "not_invited" {
		t.Fatal("uninvited accept")
	}
	send(h, "i:b", map[string]any{"type": "party.accept", "partyId": "pty_id1"})
	r = b.find("party")
	if r == nil || len(r["members"].([]any)) != 2 {
		t.Fatalf("accept roster: %v", r)
	}
	if got, _ := mr.Get("gateway:test:partyOf:ch_l:ub"); got != "pty_id1" {
		t.Fatalf("partyOf mirror: %q", got)
	}
	if got, _ := rx.GetParty(ctx, "ch_l", "pty_id1"); !strings.Contains(string(got), `"members":["ua","ub"]`) {
		t.Fatalf("roster mirror: %s", got)
	}
	// Full: a third invite is refused at the cap.
	send(h, "i:a", map[string]any{"type": "party.invite", "userId": "uc"})
	if a.last()["code"] != "party_full" {
		t.Fatalf("cap: %v", a.last())
	}
	// Party chat reaches both members only.
	c.reset()
	send(h, "i:b", map[string]any{"type": "say", "scope": "party", "text": "yo"})
	if a.find("say") == nil || c.find("say") != nil {
		t.Fatal("party say scope")
	}
	// Leader disconnect: roster marks offline, party survives in Redis.
	b.reset()
	h.Leave(ctx, "i:a")
	r = b.find("party")
	for _, m := range r["members"].([]any) {
		if m.(map[string]any)["userId"] == "ua" && m.(map[string]any)["online"] != false {
			t.Fatal("offline member not marked")
		}
	}
	if !mr.Exists("gateway:test:party:ch_l:pty_id1") {
		t.Fatal("party dropped on disconnect")
	}
	// Reconnect: hello carries partyId, roster re-sent.
	a2 := newRec()
	h.Join(ctx, "i:a2", "ua", a2)
	if a2.find("hello")["partyId"] != "pty_id1" || a2.find("party") == nil {
		t.Fatalf("reconnect party: %v", a2.types())
	}
	// Leader leaves: leadership passes; empty party dissolves.
	send(h, "i:a2", map[string]any{"type": "party.leave"})
	if a2.last()["partyId"] != "" {
		t.Fatal("leaver not told")
	}
	if r = b.find("party"); r["leaderId"] != "ub" {
		t.Fatalf("leadership: %v", r)
	}
	if mr.Exists("gateway:test:partyOf:ch_l:ua") {
		t.Fatal("leaver partyOf kept")
	}
	send(h, "i:b", map[string]any{"type": "party.leave"})
	if mr.Exists("gateway:test:party:ch_l:pty_id1") || h.reg.Gauges.Parties.Load() != 0 {
		t.Fatal("empty party not dissolved")
	}
	send(h, "i:b", map[string]any{"type": "party.list"})
	if b.last()["partyId"] != "" {
		t.Fatal("list after leave")
	}
	// Decline notifies the leader.
	send(h, "i:c", map[string]any{"type": "party.create"})
	send(h, "i:c", map[string]any{"type": "party.invite", "userId": "ub"})
	send(h, "i:b", map[string]any{"type": "party.decline", "partyId": "pty_id2"})
	if d := c.find("party.declined"); d == nil || d["userId"] != "ub" {
		t.Fatalf("declined: %v", c.types())
	}
}

func TestPartyRestoredAfterRestart(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	rx := redisx.Wrap(rdb, "test")
	_ = rx.SetParty(context.Background(), "ch_l", "pty_old", []byte(`{"id":"pty_old","leaderId":"ua","members":["ua","ub"],"invited":[]}`), []string{"ua", "ub"})
	h := New(Options{ChannelID: "ch_l", Config: cfg(), Redis: rx})
	defer h.Stop(1001, "")
	b := newRec()
	h.Join(context.Background(), "i:b", "ub", b)
	// After a gateway restart the roster is not known when `hello` goes out;
	// the `party` frame that follows carries it.
	if types := b.types(); types[0] != "hello" || types[1] != "party" {
		t.Fatalf("party not restored from redis: %v", types)
	}
	r := b.find("party")
	if r == nil || r["leaderId"] != "ua" || len(r["members"].([]any)) != 2 {
		t.Fatalf("restored roster: %v", r)
	}
}

func TestJoinRefusedAfterStop(t *testing.T) {
	h, _, _ := newHub(t, cfg())
	h.Stop(1001, "test")
	if h.Join(context.Background(), "i:z", "uz", newRec()) {
		t.Fatal("stopped hub accepted a join")
	}
}

func TestHelloIsFirstEvenWithTraffic(t *testing.T) {
	h, _, _ := newHub(t, cfg())
	ctx := context.Background()
	a, b := newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	send(h, "i:a", map[string]any{"type": "party.create"})
	h.Join(ctx, "i:b", "ub", b)
	if b.types()[0] != "hello" {
		t.Fatalf("first frame: %v", b.types())
	}
	send(h, "i:a", map[string]any{"type": "party.invite", "userId": "ub"})
	send(h, "i:a", map[string]any{"type": "party.invite", "userId": "ub"})
	if n := len(b.types()); n != 2 {
		t.Fatalf("duplicate invite delivered: %v", b.types())
	}
	// Invitee disconnect clears the pending invite.
	h.Leave(ctx, "i:b")
	if r := a.find("party"); r["invited"] != nil && len(r["invited"].([]any)) != 0 {
		t.Fatalf("invite kept after invitee left: %v", r)
	}
}

package q

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

type rec struct {
	mu     sync.Mutex
	frames []string
	closed int
	allow  bool
}

func newRec() *rec { return &rec{allow: true} }
func (r *rec) SendRaw(b []byte) bool {
	r.mu.Lock()
	r.frames = append(r.frames, string(b))
	r.mu.Unlock()
	return true
}
func (r *rec) SendError(code, msg string) { r.SendRaw([]byte(`error:` + code)) }
func (r *rec) Close(code int, reason string) {
	r.mu.Lock()
	r.closed = code
	r.mu.Unlock()
}
func (r *rec) Allow() bool { return r.allow }
func (r *rec) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.frames...)
}
func (r *rec) code() int { r.mu.Lock(); defer r.mu.Unlock(); return r.closed }

func names() console.Redis {
	return console.Redis{EventKeyPrefix: "game:test:ch_q:event:", QueueKeyPrefix: "game:test:ch_q:queue:", ChannelPrefix: "game:out:test:ch_q:"}
}

func setup(t *testing.T) (*Bridge, *miniredis.Miniredis, *redis.Client, *time.Time) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	now := time.Unix(1000, 0)
	n := 0
	b := New(Options{ChannelID: "ch_q", Redis: redisx.Wrap(rdb, "test"), Names: names(), Now: func() time.Time { return now },
		NewID: func() string { n++; return "msg" + string(rune('0'+n)) }})
	mr.Set("game:test:ch_q:event:g1", `{"gameId":"g1","members":[{"memberId":"ua","name":"A","email":"a@example.com"},{"memberId":"ub","name":"B","email":"b@example.com"}]}`)
	return b, mr, rdb, &now
}

func queue(t *testing.T, mr *miniredis.Miniredis) []map[string]any {
	t.Helper()
	items, _ := mr.List("game:test:ch_q:queue:g1")
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		var m map[string]any
		if err := json.Unmarshal([]byte(it), &m); err != nil {
			t.Fatalf("bad envelope %s", it)
		}
		out = append(out, m)
	}
	return out
}

func TestAuthorize(t *testing.T) {
	b, _, _, _ := setup(t)
	ctx := context.Background()
	if err := b.Authorize(ctx, "g1", "ua"); err != nil {
		t.Fatal(err)
	}
	if err := b.Authorize(ctx, "g1", "uz"); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("non-member: %v", err)
	}
	if err := b.Authorize(ctx, "nope", "ua"); !errors.Is(err, ErrUnknownGame) {
		t.Fatalf("unknown game: %v", err)
	}
	if err := b.Authorize(ctx, "", "ua"); !errors.Is(err, ErrUnknownGame) {
		t.Fatal("empty game id")
	}
}

func TestJoinPushesEnvelopeAndRelaysCommands(t *testing.T) {
	b, mr, rdb, _ := setup(t)
	ctx := context.Background()
	a := newRec()
	if err := b.Join(ctx, "g1", "i:a", "ua", a); err != nil {
		t.Fatal(err)
	}
	q := queue(t, mr)
	if len(q) != 1 || q[0]["awaitPolicy"].(float64) != 0 || q[0]["messageId"] != "msg1" {
		t.Fatalf("enter envelope: %v", q)
	}
	item := q[0]["item"].(map[string]any)
	if item["type"] != "enter" || item["connectionId"] != "i:a" || item["memberId"] != "ua" {
		t.Fatalf("enter item: %v", item)
	}
	if mr.TTL("game:test:ch_q:queue:g1") <= 0 {
		t.Fatal("queue has no ttl")
	}
	if !mr.Exists("gateway:test:session:q:ch_q:ua") {
		t.Fatal("session not claimed")
	}
	// Inbound: connectionId is stamped by the gateway, never trusted.
	b.Handle(ctx, "g1", "i:a", []byte(`{"type":"move","dir":"n","connectionId":"spoof"}`))
	q = queue(t, mr)
	if it := q[1]["item"].(map[string]any); it["connectionId"] != "i:a" || it["dir"] != "n" {
		t.Fatalf("stamped item: %v", it)
	}
	b.Handle(ctx, "g1", "i:a", []byte(`{"type":"enter","memberId":"ub"}`))
	b.Handle(ctx, "g1", "i:a", []byte(`[1]`))
	b.Handle(ctx, "g1", "i:a", []byte(`{"notype":1}`))
	if got := strings.Join(a.all(), ","); got != "error:reserved_type,error:bad_message,error:bad_message" {
		t.Fatalf("refusals: %s", got)
	}
	if len(queue(t, mr)) != 2 {
		t.Fatal("refused frames reached the queue")
	}
	// Outbound: one publish fans out to the named sockets; unknown ids are ignored.
	b2 := newRec()
	_ = b.Join(ctx, "g1", "i:b", "ub", b2)
	deadline := time.Now().Add(2 * time.Second)
	for rdb.PubSubNumSub(ctx, "game:out:test:ch_q:g1").Val()["game:out:test:ch_q:g1"] == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionIds":["i:a","i:b","ghost"],"message":{"type":"snapshot","t":1}}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","message":"only-a"}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"drop","connectionId":"i:b"}`)
	deadline = time.Now().Add(2 * time.Second)
	for b2.code() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := a.all(); len(got) != 5 || got[3] != `{"type":"snapshot","t":1}` || got[4] != `"only-a"` {
		t.Fatalf("a frames: %v", got)
	}
	if got := b2.all(); len(got) != 1 || got[0] != `{"type":"snapshot","t":1}` || b2.code() != 1000 {
		t.Fatalf("b frames: %v code %d", got, b2.code())
	}
	// Leave pushes `leave`; the last socket unsubscribes.
	b.Leave(ctx, "g1", "i:a")
	q = queue(t, mr)
	if it := q[len(q)-1]["item"].(map[string]any); it["type"] != "leave" || it["connectionId"] != "i:a" {
		t.Fatalf("leave item: %v", it)
	}
	if mr.Exists("gateway:test:session:q:ch_q:ua") {
		t.Fatal("session not released")
	}
	b.Leave(ctx, "g1", "i:b")
	if !b.Empty() || b.reg.Gauges.Subscriptions.Load() != 0 {
		t.Fatal("game not dropped after the last leave")
	}
}

func TestReplaceSameMember(t *testing.T) {
	b, _, _, _ := setup(t)
	ctx := context.Background()
	a1, a2 := newRec(), newRec()
	_ = b.Join(ctx, "g1", "i:1", "ua", a1)
	_ = b.Join(ctx, "g1", "i:2", "ua", a2)
	if a1.code() != 4000 {
		t.Fatalf("orphan not closed: %d", a1.code())
	}
	b.Leave(ctx, "g1", "i:1")
	if b.stats.Connections.Load() != 1 {
		t.Fatalf("connection stat after replace: %d", b.stats.Connections.Load())
	}
}

func TestAbortOnDepthCapAndNoProgress(t *testing.T) {
	b, mr, _, now := setup(t)
	ctx := context.Background()
	a := newRec()
	_ = b.Join(ctx, "g1", "i:a", "ua", a)
	for i := 0; i < DepthCap; i++ {
		b.Handle(ctx, "g1", "i:a", []byte(`{"type":"m"}`))
	}
	if a.code() != 4001 || mr.Exists("game:test:ch_q:queue:g1") || b.reg.Counters.Aborts.Load() != 1 {
		t.Fatalf("depth cap abort: code=%d exists=%v aborts=%d", a.code(), mr.Exists("game:test:ch_q:queue:g1"), b.reg.Counters.Aborts.Load())
	}
	// A reconnect to the aborted game is refused until it is dropped.
	if err := b.Join(ctx, "g1", "i:a3", "ua", newRec()); !errors.Is(err, ErrAborted) {
		t.Fatalf("join after abort: %v", err)
	}
	b.Leave(ctx, "g1", "i:a")
	if mr.Exists("game:test:ch_q:queue:g1") {
		t.Fatal("leave after abort re-created the queue")
	}

	// No-progress: depth stays above steady for longer than NoProgress.
	c := newRec()
	_ = b.Join(ctx, "g1", "i:c", "ua", c)
	for i := 0; i < SteadyDepth+5; i++ {
		b.Handle(ctx, "g1", "i:c", []byte(`{"type":"m"}`))
	}
	if c.code() != 0 {
		t.Fatal("aborted too early")
	}
	*now = now.Add(NoProgress + time.Second)
	b.Handle(ctx, "g1", "i:c", []byte(`{"type":"m"}`))
	if c.code() != 4001 {
		t.Fatalf("no-progress abort: %d", c.code())
	}
	// A draining actor resets the clock: depth back under steady is healthy.
	b.Leave(ctx, "g1", "i:c")
	d := newRec()
	_ = b.Join(ctx, "g1", "i:d", "ua", d)
	for i := 0; i < SteadyDepth+5; i++ {
		b.Handle(ctx, "g1", "i:d", []byte(`{"type":"m"}`))
	}
	mr.Del("game:test:ch_q:queue:g1") // the actor flushed everything
	*now = now.Add(NoProgress + time.Second)
	b.Handle(ctx, "g1", "i:d", []byte(`{"type":"m"}`))
	if d.code() != 0 {
		t.Fatal("healthy game aborted")
	}
}

func TestStoppedBridgeRefusesJoin(t *testing.T) {
	b, _, _, _ := setup(t)
	b.Stop(1001, "bye")
	if err := b.Join(context.Background(), "g1", "i:a", "ua", newRec()); !errors.Is(err, ErrStopped) {
		t.Fatalf("join after stop: %v", err)
	}
}

func TestMemberIDStrippedAndRedisOutageSurfaced(t *testing.T) {
	b, mr, _, _ := setup(t)
	ctx := context.Background()
	a := newRec()
	_ = b.Join(ctx, "g1", "i:a", "ua", a)
	b.Handle(ctx, "g1", "i:a", []byte(`{"type":"chat","memberId":"victim","text":"x"}`))
	q := queue(t, mr)
	if it := q[1]["item"].(map[string]any); it["memberId"] != nil || it["text"] != "x" {
		t.Fatalf("memberId not stripped: %v", it)
	}
	mr.Close()
	for i := 0; i < pushFailureLimit; i++ {
		b.Handle(ctx, "g1", "i:a", []byte(`{"type":"m"}`))
	}
	frames := a.all()
	if len(frames) < pushFailureLimit || frames[len(frames)-1] != "error:unavailable" {
		t.Fatalf("client not told about the outage: %v", frames)
	}
	if a.code() != 4001 {
		t.Fatalf("persistent outage did not abort: %d", a.code())
	}
}

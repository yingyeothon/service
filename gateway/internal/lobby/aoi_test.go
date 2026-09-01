package lobby

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

func aoiCfg(rng float64, maxPeers int) console.LobbyConfig {
	c := cfg()
	c.AOI = &console.LobbyAOI{Range: rng, MaxPeers: maxPeers}
	return c
}

// newClockHub is newHub with an injectable clock for the persist window.
func newClockHub(t *testing.T, c console.LobbyConfig, now *time.Time) (*Hub, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	n := 0
	h := New(Options{ChannelID: "ch_l", Config: c, Redis: redisx.Wrap(rdb, "test"),
		NewID: func() string { n++; return fmt.Sprintf("id%d", n) }, Now: func() time.Time { return *now }})
	t.Cleanup(func() { h.Stop(1001, "test") })
	return h, mr
}

func pos(h *Hub, id string, x, y float64) {
	send(h, id, map[string]any{"type": "pos", "zone": "Zone001", "x": x, "y": y})
}

func count(r *rec, t string) int {
	n := 0
	for _, x := range r.types() {
		if x == t {
			n++
		}
	}
	return n
}

func peerIDs(f map[string]any) string {
	if f == nil {
		return "<none>"
	}
	var ids []string
	for _, p := range f["peers"].([]any) {
		ids = append(ids, p.(map[string]any)["userId"].(string))
	}
	return strings.Join(ids, ",")
}

func TestAOIBoxViewAndCrossing(t *testing.T) {
	h, _, _ := newHub(t, aoiCfg(10, 64))
	ctx := context.Background()
	a, b, c := newRec(), newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	if hello := a.find("hello"); hello["aoi"] == nil || hello["aoi"].(map[string]any)["range"].(float64) != 10 || hello["aoi"].(map[string]any)["maxPeers"].(float64) != 64 {
		t.Fatalf("hello should carry the aoi box: %v", hello)
	}
	pos(h, "i:a", 0, 0)
	h.Join(ctx, "i:b", "ub", b)
	pos(h, "i:b", 10, 0) // exactly on the edge: in view
	h.Join(ctx, "i:c", "uc", c)
	pos(h, "i:c", 11, 0) // one past the edge of a, next to b
	if got := peerIDs(b.find("snapshot")); got != "ua" {
		t.Fatalf("b snapshot: %s", got)
	}
	if got := peerIDs(c.find("snapshot")); got != "ub" {
		t.Fatalf("c snapshot must not include a (11 > 10): %s", got)
	}
	if count(a, "enter") != 1 || a.find("enter")["userId"] != "ub" {
		t.Fatalf("a should see only b enter: %v", a.types())
	}
	if count(b, "enter") != 1 || b.find("enter")["userId"] != "uc" {
		t.Fatalf("b should see c enter: %v", b.types())
	}
	h.Flush(ctx) // drain the entry positions
	// Zone chat reaches whoever has the speaker in view.
	a.reset()
	b.reset()
	c.reset()
	send(h, "i:a", map[string]any{"type": "say", "scope": "zone", "text": "hi"})
	if count(a, "say") != 1 || count(b, "say") != 1 || count(c, "say") != 0 {
		t.Fatalf("zone say should follow the view: a=%v b=%v c=%v", a.types(), b.types(), c.types())
	}
	// c steps into a's box: exactly one enter on each side, then positions.
	a.reset()
	c.reset()
	pos(h, "i:c", 10, 0)
	if len(a.types()) != 0 {
		t.Fatalf("view changes wait for the flush: %v", a.types())
	}
	h.Flush(ctx)
	if got := a.types(); count(a, "enter") != 1 || a.find("enter")["userId"] != "uc" || got[0] != "enter" || got[len(got)-1] != "pos" {
		t.Fatalf("a after c stepped in: %v", got)
	}
	if got := peerIDs(a.find("pos")); got != "uc" {
		t.Fatalf("a pos batch: %s", got)
	}
	if count(c, "enter") != 1 || c.find("enter")["userId"] != "ua" {
		t.Fatalf("c should see a enter: %v", c.types())
	}
	// c steps back out: exactly one leave, and no pos frame for a (nothing
	// a can see moved).
	a.reset()
	b.reset()
	c.reset()
	pos(h, "i:c", 11, 0)
	h.Flush(ctx)
	if got := a.types(); len(got) != 1 || got[0] != "leave" || a.find("leave")["userId"] != "uc" {
		t.Fatalf("a after c stepped out: %v", got)
	}
	if got := c.types(); len(got) != 2 || got[0] != "leave" || c.find("leave")["userId"] != "ua" || peerIDs(c.find("pos")) != "uc" {
		t.Fatalf("c after stepping out: %v", got)
	}
	// Negative coordinates bucket with floor, not truncation: (-1,-1) and
	// (-11,-11) are 10 apart (in view); (-12,-12) is not.
	n1, n2, n3 := newRec(), newRec(), newRec()
	h.Join(ctx, "i:n1", "n1", n1)
	pos(h, "i:n1", -1, -1)
	h.Join(ctx, "i:n2", "n2", n2)
	pos(h, "i:n2", -11, -11)
	h.Join(ctx, "i:n3", "n3", n3)
	pos(h, "i:n3", -12, -12)
	if peerIDs(n2.find("snapshot")) != "n1" || peerIDs(n3.find("snapshot")) != "n2" {
		t.Fatalf("negative coordinates: n2=%s n3=%s", peerIDs(n2.find("snapshot")), peerIDs(n3.find("snapshot")))
	}
	for _, id := range []string{"i:n1", "i:n2", "i:n3"} {
		h.Leave(ctx, id)
	}
	if got := peerIDs(b.find("pos")); got != "uc" || count(b, "enter")+count(b, "leave") != 0 {
		t.Fatalf("b (still next to c) only sees the move: %v", b.types())
	}
	// A second flush with nothing moved is silent everywhere.
	a.reset()
	b.reset()
	c.reset()
	h.Flush(ctx)
	if len(a.types())+len(b.types())+len(c.types()) != 0 {
		t.Fatal("idle flush sent frames")
	}
	// Disconnect: only viewers get the leave.
	pos(h, "i:c", 10, 0)
	h.Flush(ctx)
	a.reset()
	b.reset()
	h.Leave(ctx, "i:c")
	if count(a, "leave") != 1 || count(b, "leave") != 1 {
		t.Fatalf("leave on disconnect: a=%v b=%v", a.types(), b.types())
	}
}

func TestAOIMaxPeersNearestFirst(t *testing.T) {
	h, _, _ := newHub(t, aoiCfg(10, 2))
	ctx := context.Background()
	v := newRec()
	peers := map[string]*rec{}
	for i, x := range []float64{3, 1, 2} {
		id := fmt.Sprintf("p%d", i)
		r := newRec()
		peers[id] = r
		h.Join(ctx, "i:"+id, id, r)
		pos(h, "i:"+id, x, 0)
	}
	h.Join(ctx, "i:v", "uv", v)
	pos(h, "i:v", 0, 0)
	// p1 (x=1) and p2 (x=2) are nearest; p0 (x=3) is cut.
	if got := peerIDs(v.find("snapshot")); got != "p1,p2" {
		t.Fatalf("snapshot should keep the two nearest: %s", got)
	}
	// Views are receiver-owned: p1 (x=1) now has p2 and v at distance 1, so
	// v enters its view and p0 (distance 2) is evicted with a leave, while
	// p0's own view (p1, p2 nearer than v) never learns of v.
	if p1 := peers["p1"]; p1.find("enter")["userId"] != "uv" || p1.find("leave")["userId"] != "p0" {
		t.Fatalf("p1 view: %v", p1.types())
	}
	if p0 := peers["p0"]; count(p0, "enter") != 2 || p0.find("enter")["userId"] == "uv" {
		t.Fatalf("p0 view is full: %v", p0.types())
	}
	// Equal distance is cut by userID, so the cut is predictable.
	e := newRec()
	h.Join(ctx, "i:e", "p0a", e) // x=1 like p1; "p0a" < "p1"
	pos(h, "i:e", -1, 0)
	if got := peerIDs(e.find("snapshot")); got != "p1,uv" {
		t.Fatalf("e snapshot: %s", got)
	}
	if got := v.find("leave"); got == nil || got["userId"] != "p2" || v.find("enter")["userId"] != "p0a" {
		// v at 0: p0a(1) p1(1) p2(2) — p0a wins the tie with p1, p2 is cut.
		t.Fatalf("tie-break by userID: %v", v.types())
	}
	h.Leave(ctx, "i:e")
	// The cut peer's moves never reach v.
	h.Flush(ctx) // drain the entry positions
	v.reset()
	pos(h, "i:p0", 4, 0)
	h.Flush(ctx)
	if len(v.types()) != 0 {
		t.Fatalf("cut peer leaked: %v", v.types())
	}
	// When a visible peer leaves, the next nearest takes its slot.
	v.reset()
	h.Leave(ctx, "i:p1")
	if got := v.types(); len(got) != 2 || got[0] != "enter" || got[1] != "leave" || v.find("enter")["userId"] != "p0" || v.find("leave")["userId"] != "p1" {
		t.Fatalf("slot handover: %v", got)
	}
}

func TestAOIReconfigureRederivesViews(t *testing.T) {
	h, _, _ := newHub(t, cfg())
	ctx := context.Background()
	a, b := newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	pos(h, "i:a", 0, 0)
	h.Join(ctx, "i:b", "ub", b)
	pos(h, "i:b", 50, 0)
	if peerIDs(b.find("snapshot")) != "ua" {
		t.Fatal("zone-wide before aoi")
	}
	a.reset()
	b.reset()
	h.Reconfigure(aoiCfg(10, 64))
	if count(a, "leave") != 1 || count(b, "leave") != 1 {
		t.Fatalf("turning aoi on must retract out-of-box peers: a=%v b=%v", a.types(), b.types())
	}
	a.reset()
	b.reset()
	h.Reconfigure(cfg())
	if count(a, "enter") != 1 || count(b, "enter") != 1 {
		t.Fatalf("turning aoi off must re-announce: a=%v b=%v", a.types(), b.types())
	}
	// A replaced socket re-enters and its viewers get a fresh enter, as
	// without AOI.
	h.Reconfigure(aoiCfg(10, 64))
	pos(h, "i:b", 47, 0)
	pos(h, "i:b", 44, 0)
	pos(h, "i:a", 3, 0)
	pos(h, "i:a", 6, 0)
	pos(h, "i:a", 9, 0)
	pos(h, "i:a", 12, 0)
	pos(h, "i:a", 15, 0)
	pos(h, "i:a", 18, 0)
	pos(h, "i:a", 21, 0)
	pos(h, "i:a", 24, 0)
	pos(h, "i:a", 27, 0)
	pos(h, "i:a", 30, 0)
	pos(h, "i:a", 33, 0)
	pos(h, "i:a", 34, 0)
	h.Flush(ctx)
	a.reset()
	b.reset()
	if _, ok := a.find("enter")["userId"]; ok {
		t.Fatal("reset")
	}
	a2 := newRec()
	h.Join(ctx, "i:a2", "ua", a2)
	if count(b, "leave") != 0 || count(b, "enter") != 1 {
		t.Fatalf("replacement: viewer should get one enter and no leave: %v", b.types())
	}
	if peerIDs(a2.find("snapshot")) != "ub" {
		t.Fatalf("restored socket snapshot: %s", peerIDs(a2.find("snapshot")))
	}
}

func TestPosPersistWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	h, mr := newClockHub(t, cfg(), &now)
	ctx := context.Background()
	a := newRec()
	h.Join(ctx, "i:a", "ua", a)
	pos(h, "i:a", 1, 0)
	key := "gateway:test:pos:ch_l:ua"
	h.Flush(ctx)
	if got, _ := mr.Get(key); !strings.Contains(got, `"x":1`) {
		t.Fatalf("first flush persists at once: %s", got)
	}
	// Within the window nothing is written; the move is pending.
	now = now.Add(200 * time.Millisecond)
	pos(h, "i:a", 2, 0)
	h.Flush(ctx)
	if got, _ := mr.Get(key); !strings.Contains(got, `"x":1`) {
		t.Fatalf("second flush inside the window should not write: %s", got)
	}
	now = now.Add(posPersistEvery)
	pos(h, "i:a", 3, 0)
	h.Flush(ctx)
	if got, _ := mr.Get(key); !strings.Contains(got, `"x":3`) {
		t.Fatalf("flush after the window writes the newest: %s", got)
	}
	// A move that never reached a flush is still persisted on disconnect.
	pos(h, "i:a", 4, 0)
	h.Leave(ctx, "i:a")
	if got, _ := mr.Get(key); !strings.Contains(got, `"x":4`) {
		t.Fatalf("leave must persist the last position: %s", got)
	}
	// And a pending (flushed, not yet written) move on a zone change.
	a2 := newRec()
	h.Join(ctx, "i:a2", "ua", a2)
	now = now.Add(posPersistEvery)
	pos(h, "i:a2", 5, 0)
	h.Flush(ctx)
	now = now.Add(100 * time.Millisecond)
	pos(h, "i:a2", 6, 0)
	h.Flush(ctx)
	send(h, "i:a2", map[string]any{"type": "pos", "zone": "Zone002", "x": 0, "y": 0})
	if got, _ := mr.Get(key); !strings.Contains(got, `"x":6`) || !strings.Contains(got, `"zone":"Zone001"`) {
		t.Fatalf("zone change must persist the pending position: %s", got)
	}
}

// A peer can move out of a viewer's 3×3 cells between flushes and then leave
// the zone (disconnect, zone change, replacement): the viewer's view was
// derived at the last flush and still holds it, so it must get the `leave`.
func TestAOILeaveReachesViewersOutsideTheCells(t *testing.T) {
	h, _, _ := newHub(t, aoiCfg(1, 64))
	ctx := context.Background()
	v, m := newRec(), newRec()
	h.Join(ctx, "i:v", "uv", v)
	pos(h, "i:v", 0, 0)
	h.Join(ctx, "i:m", "um", m)
	pos(h, "i:m", 1, 0)
	h.Flush(ctx)
	if v.find("enter")["userId"] != "um" {
		t.Fatalf("setup: %v", v.types())
	}
	// Three steps of maxMoveDelta 3 within one tick: far outside v's cells.
	pos(h, "i:m", 4, 0)
	pos(h, "i:m", 7, 0)
	v.reset()
	h.Leave(ctx, "i:m")
	if got := v.types(); len(got) != 1 || got[0] != "leave" || v.find("leave")["userId"] != "um" {
		t.Fatalf("disconnect after leaving the cells: %v", got)
	}
	// Zone change, same shape.
	m2 := newRec()
	h.Join(ctx, "i:m2", "um", m2) // restored at x=7: walk back within maxMoveDelta
	pos(h, "i:m2", 4, 0)
	pos(h, "i:m2", 1, 0)
	if m2.find("error") != nil {
		t.Fatalf("setup refused: %v", m2.types())
	}
	h.Flush(ctx)
	pos(h, "i:m2", 4, 0)
	v.reset()
	send(h, "i:m2", map[string]any{"type": "pos", "zone": "Zone002", "x": 0, "y": 0})
	if got := v.types(); len(got) != 1 || got[0] != "leave" {
		t.Fatalf("zone change after leaving the cells: %v", got)
	}
	// Replacement: viewers forget silently, then the successor re-enters.
	send(h, "i:m2", map[string]any{"type": "pos", "zone": "Zone001", "x": 1, "y": 0})
	h.Flush(ctx)
	pos(h, "i:m2", 4, 0)
	v.reset()
	m3 := newRec()
	h.Join(ctx, "i:m3", "um", m3) // restored at x=4: outside v's box
	if len(v.types()) != 0 {
		t.Fatalf("replacement must be silent: %v", v.types())
	}
	pos(h, "i:m3", 1, 0)
	h.Flush(ctx)
	if v.find("enter")["userId"] != "um" || count(v, "leave") != 0 {
		t.Fatalf("successor walking back in must be a fresh enter: %v", v.types())
	}
}

// refusing wraps a recorder whose Send refuses one frame type, the way
// `conn.SendRaw` refuses a frame over the outbound cap.
type refusing struct {
	*rec
	refuse string
}

func (r *refusing) Send(v any) bool {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["type"] == r.refuse {
		return false
	}
	return r.rec.SendRaw(b)
}

func TestRefusedSnapshotDoesNotCountAsSeen(t *testing.T) {
	h, _, _ := newHub(t, aoiCfg(10, 64))
	ctx := context.Background()
	a := newRec()
	h.Join(ctx, "i:a", "ua", a)
	pos(h, "i:a", 0, 0)
	b := &refusing{rec: newRec(), refuse: "snapshot"}
	h.Join(ctx, "i:b", "ub", b)
	pos(h, "i:b", 1, 0)
	if b.find("snapshot") != nil {
		t.Fatal("test wrapper should have refused the snapshot")
	}
	h.Flush(ctx)
	if e := b.find("enter"); e == nil || e["userId"] != "ua" {
		t.Fatalf("a peer the client never saw must arrive as enter: %v", b.types())
	}
}

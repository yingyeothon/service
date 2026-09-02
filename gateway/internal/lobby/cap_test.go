package lobby

import (
	"context"
	"fmt"
	"testing"
)

// The peer cap applies to every channel: without an AOI box a zone over
// MaxPeers shows each client its nearest MaxPeers peers, and a move can
// swap who is in view — announced as enter/leave before that tick's pos.
func TestMaxPeersCapWithoutAOI(t *testing.T) {
	c := cfg()
	c.MaxPeers = 2
	c.FlushIntervalMs = 60_000 // exact frame sequences: no background flush
	h, _, _ := newHub(t, c)
	ctx := context.Background()
	socks := map[string]*rec{}
	for i, x := range []float64{0, 1, 2, 10} {
		id := fmt.Sprintf("u%d", i)
		socks[id] = newRec(t)
		h.Join(ctx, "i:"+id, id, socks[id])
		pos(h, "i:"+id, x, 0)
	}
	// u3 at x=10 sees the nearest two: u2 (8) and u1 (9), not u0 (10).
	if got := peerIDs(socks["u3"].find("snapshot")); got != "u1,u2" {
		t.Fatalf("nearest-first cut without aoi: %s", got)
	}
	// hello states the cap even without a box.
	if aoi := socks["u3"].find("hello")["aoi"].(map[string]any); aoi["maxPeers"] != float64(2) || aoi["range"] != nil {
		t.Fatalf("hello aoi: %v", aoi)
	}
	h.Flush(ctx) // the setup positions
	// u0 walks to x=11: for u3 it is now nearest, evicting u1 (9 away).
	socks["u3"].reset()
	for _, x := range []float64{3, 6, 9, 11} {
		pos(h, "i:u0", x, 0)
	}
	h.Flush(ctx)
	if got := socks["u3"].types(); len(got) != 3 || got[0] != "enter" || got[1] != "leave" || got[2] != "pos" {
		t.Fatalf("a move must flip the capped view before the batch: %v", got)
	}
	if e, l := socks["u3"].find("enter"), socks["u3"].find("leave"); e["userId"] != "u0" || l["userId"] != "u1" {
		t.Fatalf("enter u0 / leave u1: %v %v", e, l)
	}
	if got := peerIDs(socks["u3"].find("pos")); got != "u0" {
		t.Fatalf("the batch carries only peers in view: %s", got)
	}
	// Zone chat follows the view: u1 is out of u3's view now.
	socks["u3"].reset()
	send(h, "i:u1", map[string]any{"type": "say", "scope": "zone", "text": "hello?"})
	if socks["u3"].find("say") != nil {
		t.Fatalf("zone say from a peer out of view must not arrive: %v", socks["u3"].types())
	}
	send(h, "i:u0", map[string]any{"type": "say", "scope": "zone", "text": "hi"})
	if socks["u3"].find("say") == nil {
		t.Fatalf("zone say from a peer in view: %v", socks["u3"].types())
	}
}

// A wholesale view change is one snapshot, not a burst of enter/leave: a
// config change that admits a crowd must not fill the control queue.
func TestLargeViewDiffIsASnapshot(t *testing.T) {
	c := cfg()
	c.MaxPeers = 1
	c.FlushIntervalMs = 60_000
	h, _, _ := newHub(t, c)
	ctx := context.Background()
	v := newRec(t)
	h.Join(ctx, "i:v", "uv", v)
	pos(h, "i:v", 0, 0)
	for i := 0; i < snapshotOver+5; i++ {
		id := fmt.Sprintf("u%02d", i)
		h.Join(ctx, "i:"+id, id, newRec(t))
		pos(h, "i:"+id, float64(i+1), 0)
	}
	if got := peerIDs(v.find("snapshot")); got != "" || count(v, "enter") != 1 {
		t.Fatalf("setup: cap 1 shows one peer: snapshot=%q enters=%d", got, count(v, "enter"))
	}
	v.reset()
	next := c
	next.MaxPeers = 256
	h.Reconfigure(next)
	if got := v.types(); len(got) != 1 || got[0] != "snapshot" {
		t.Fatalf("raising the cap over %d peers must be one snapshot: %v", snapshotOver, got)
	}
	if n := len(v.find("snapshot")["peers"].([]any)); n != snapshotOver+5 {
		t.Fatalf("snapshot carries the whole view: %d", n)
	}
	v.reset()
	h.Reconfigure(c)
	if got := v.types(); len(got) != 1 || got[0] != "snapshot" || len(v.find("snapshot")["peers"].([]any)) != 1 {
		t.Fatalf("shrinking it back is one snapshot too: %v", got)
	}
	// A small diff stays per-peer.
	v.reset()
	mid := c
	mid.MaxPeers = 3
	h.Reconfigure(mid)
	if got := v.types(); len(got) != 2 || got[0] != "enter" || got[1] != "enter" {
		t.Fatalf("a diff under the threshold is enter/leave: %v", got)
	}
}

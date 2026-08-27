package server

import (
	"testing"
	"time"
)

// Mirrors the smoke: a, b connect; a2 replaces a; a2 and b close. The
// per-channel connection stat must return to zero.
func TestChannelConnectionStatBalances(t *testing.T) {
	f := newFixture(t)
	a, _, err := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUA)
	if err != nil {
		t.Fatal(err)
	}
	read(t, a)
	_ = a.WriteJSON(map[string]any{"type": "pos", "zone": "Zone001", "x": 1, "y": 1})
	b, _, _ := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUB)
	read(t, b)
	_ = b.WriteJSON(map[string]any{"type": "pos", "zone": "Zone001", "x": 2, "y": 2})
	a2, _, _ := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUA)
	read(t, a2)
	_ = a2.SetReadDeadline(time.Now().Add(time.Second))
	for {
		if _, _, err := a.ReadMessage(); err != nil {
			break
		}
	}
	_ = a2.Close()
	_ = b.Close()
	deadline := time.Now().Add(3 * time.Second)
	for f.server.reg.Gauges.Connections.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := f.server.reg.Channel("lobby_0123456789abcdef").Connections.Load(); got != 0 {
		t.Fatalf("channel stat: %d (accepted %d)", got, f.server.reg.Counters.ConnectionsAccepted.Load())
	}
}

package lobby

import (
	"context"
	"testing"
)

// Mirrors the smoke sequence: a, b join; a2 replaces a; a2 and b leave.
func TestConnectionStatBalances(t *testing.T) {
	h, _, _ := newHub(t, cfg())
	ctx := context.Background()
	a, b, a2 := newRec(), newRec(), newRec()
	h.Join(ctx, "i:a", "ua", a)
	send(h, "i:a", map[string]any{"type": "pos", "zone": "town", "x": 1, "y": 1})
	h.Join(ctx, "i:b", "ub", b)
	send(h, "i:b", map[string]any{"type": "pos", "zone": "town", "x": 2, "y": 2})
	send(h, "i:a", map[string]any{"type": "party.create"})
	h.Join(ctx, "i:a2", "ua", a2)
	h.Leave(ctx, "i:a")
	h.Leave(ctx, "i:a2")
	h.Leave(ctx, "i:b")
	if got := h.stats.Connections.Load(); got != 0 {
		t.Fatalf("stat after everyone left: %d", got)
	}
}

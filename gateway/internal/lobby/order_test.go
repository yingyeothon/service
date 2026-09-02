package lobby

import (
	"bytes"
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// blocking is a recorder whose `pos` batch blocks (once armed) until `hold`
// is closed, so a test can stop Flush at its send and race another hub call
// against it.
type blocking struct {
	*rec
	armed   atomic.Bool
	hold    chan struct{}
	blocked chan struct{}
}

func (b *blocking) SendRaw(raw []byte) bool {
	if b.armed.Load() && bytes.HasPrefix(raw, []byte(`{"type":"pos"`)) {
		select {
		case b.blocked <- struct{}{}:
		default:
		}
		<-b.hold
	}
	return b.rec.SendRaw(raw)
}

// A `pos` batch decided while a peer was visible must reach the socket
// before the `leave` that removes the peer — the two are ordered by the hub
// lock, so a concurrent Leave has to wait for Flush's sends.
func TestFlushOrderedAgainstLeave(t *testing.T) {
	c := cfg()
	c.FlushIntervalMs = 60_000 // the loop must not flush behind the test's back
	h, _, _ := newHub(t, c)
	ctx := context.Background()
	v := &blocking{rec: newRec(t), hold: make(chan struct{}), blocked: make(chan struct{}, 1)}
	t.Cleanup(func() {
		select {
		case <-v.hold:
		default:
			close(v.hold)
		}
	})
	m := newRec(t)
	h.Join(ctx, "i:v", "uv", v)
	pos(h, "i:v", 0, 0)
	h.Join(ctx, "i:m", "um", m)
	pos(h, "i:m", 1, 0)
	h.Flush(ctx)
	v.reset()
	v.armed.Store(true)
	pos(h, "i:m", 2, 0)
	flushed := make(chan struct{})
	go func() { h.Flush(ctx); close(flushed) }()
	<-v.blocked
	left := make(chan struct{})
	go func() { h.Leave(ctx, "i:m"); close(left) }()
	// Give Leave every chance to overtake: with the sends under the hub
	// lock it cannot, and stays parked until the batch is out.
	select {
	case <-left:
	case <-time.After(100 * time.Millisecond):
	}
	close(v.hold)
	<-flushed
	<-left
	if got := v.types(); len(got) != 2 || got[0] != "pos" || got[1] != "leave" {
		t.Fatalf("pos must precede leave: %v", got)
	}
}

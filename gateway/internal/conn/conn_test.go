package conn

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// pair returns a server-side Conn and the client socket talking to it.
func pair(t *testing.T, limits Limits, hooks Hooks) (*Conn, *websocket.Conn) {
	t.Helper()
	ready := make(chan *Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ready <- New(ws, "i:1", "u1", limits, hooks)
	}))
	t.Cleanup(srv.Close)
	cl, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cl.Close() })
	return <-ready, cl
}

func TestSendAndReadLoop(t *testing.T) {
	c, cl := pair(t, DefaultLimits(), Hooks{})
	got := make(chan string, 4)
	go func() { _ = c.ReadLoop(func(b []byte) { got <- string(b) }) }()
	if !c.Send(map[string]string{"type": "hello"}) {
		t.Fatal("send refused")
	}
	_, b, err := cl.ReadMessage()
	if err != nil || string(b) != `{"type":"hello"}` {
		t.Fatalf("client got %s %v", b, err)
	}
	if err := cl.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-got:
		if m != `{"type":"ping"}` {
			t.Fatalf("server got %s", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("inbound not delivered")
	}
	c.SendError("bad_message", "x")
	c.Close(ClosePolicy, "bye")
	_, b, _ = cl.ReadMessage()
	if string(b) != `{"type":"error","code":"bad_message","message":"x"}` {
		t.Fatalf("error frame not flushed before close: %s", b)
	}
	_, _, err = cl.ReadMessage()
	var ce *websocket.CloseError
	if !asClose(err, &ce) || ce.Code != ClosePolicy || ce.Text != "bye" {
		t.Fatalf("close code: %v", err)
	}
	select {
	case <-c.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("done not closed")
	}
	if c.Send("late") {
		t.Fatal("send after close accepted")
	}
}

func asClose(err error, ce **websocket.CloseError) bool {
	e, ok := err.(*websocket.CloseError)
	if ok {
		*ce = e
	}
	return ok
}

func TestDropOldestUnderBackpressure(t *testing.T) {
	var dropped atomic.Int32
	lim := DefaultLimits()
	lim.QueueDepth = 3
	c, cl := pair(t, lim, Hooks{OnDropped: func() { dropped.Add(1) }})
	// Stall the writer: the first write blocks in the kernel only after the
	// socket buffers fill, so pre-fill the queue while holding the write loop
	// with a large frame the client never reads.
	go func() { _ = c.ReadLoop(func([]byte) {}) }()
	big := strings.Repeat("x", lim.MaxOutbound-10)
	for i := 0; i < 400; i++ {
		c.SendRaw([]byte(`"` + big + `"`))
	}
	if dropped.Load() == 0 {
		t.Fatal("no drops with a stalled reader")
	}
	// The newest frame survives; the oldest ones were dropped.
	c.SendRaw([]byte(`"newest"`))
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = cl.SetReadDeadline(time.Now().Add(time.Second))
		_, b, err := cl.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(b) == `"newest"` {
			return
		}
	}
	t.Fatal("newest frame never arrived")
}

func TestOversizedAndBinaryRefused(t *testing.T) {
	var oversized atomic.Int32
	lim := DefaultLimits()
	lim.MaxInbound = 64
	var reported atomic.Int32
	c, cl := pair(t, lim, Hooks{OnOversized: func(size int) { oversized.Add(1); reported.Store(int32(size)) }})
	if c.SendRaw([]byte(strings.Repeat("y", lim.MaxOutbound+1))) || oversized.Load() != 1 || int(reported.Load()) != lim.MaxOutbound+1 {
		t.Fatal("oversized outbound not refused")
	}
	// The drop is not silent: the client gets a typed error in its place.
	_, b, err := cl.ReadMessage()
	if err != nil || !strings.Contains(string(b), `"code":"frame_too_large"`) || !strings.Contains(string(b), "32769-byte") {
		t.Fatalf("frame_too_large not sent: %s %v", b, err)
	}
	errc := make(chan error, 1)
	go func() { errc <- c.ReadLoop(func([]byte) {}) }()
	_ = cl.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("z", 100)))
	_, _, err = cl.ReadMessage()
	var ce *websocket.CloseError
	if !asClose(err, &ce) || ce.Code != websocket.CloseMessageTooBig {
		t.Fatalf("too-big close: %v", err)
	}
	<-errc

	c2, cl2 := pair(t, DefaultLimits(), Hooks{})
	go func() { _ = c2.ReadLoop(func([]byte) {}) }()
	_ = cl2.WriteMessage(websocket.BinaryMessage, []byte{1, 2})
	_, _, err = cl2.ReadMessage()
	if !asClose(err, &ce) || ce.Code != websocket.CloseUnsupportedData {
		t.Fatalf("binary close: %v", err)
	}
}

func TestRateLimitBucket(t *testing.T) {
	lim := DefaultLimits()
	lim.RateLimit = 5
	c, _ := pair(t, lim, Hooks{})
	now := time.Unix(0, 0)
	c.now = func() time.Time { return now }
	c.lastRef = now
	c.bucket = 10
	allowed := 0
	for i := 0; i < 20; i++ {
		if c.Allow() {
			allowed++
		}
	}
	if allowed != 10 {
		t.Fatalf("burst: %d", allowed)
	}
	now = now.Add(time.Second)
	allowed = 0
	for i := 0; i < 20; i++ {
		if c.Allow() {
			allowed++
		}
	}
	if allowed != 5 {
		t.Fatalf("refill: %d", allowed)
	}
}

func TestIdleTimeoutClosesReader(t *testing.T) {
	lim := DefaultLimits()
	lim.IdleTimeout = 200 * time.Millisecond
	lim.PingInterval = time.Hour
	c, cl := pair(t, lim, Hooks{})
	cl.SetPingHandler(func(string) error { return nil }) // never pong
	errc := make(chan error, 1)
	go func() { errc <- c.ReadLoop(func([]byte) {}) }()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrIdle) || c.CloseCode() != CloseIdle {
			t.Fatalf("expected the idle close: err=%v code=%d", err, c.CloseCode())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle socket not closed")
	}
	_ = cl.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := cl.ReadMessage()
	var ce *websocket.CloseError
	if !asClose(err, &ce) || ce.Code != CloseIdle {
		t.Fatalf("client saw %v", err)
	}
}

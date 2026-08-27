// Package conn wraps one WebSocket with the policies both strategies share
// (`todo/14` §2.2, §2.7): a bounded outbound queue that drops the *oldest*
// frame under backpressure, an inbound size cap, a per-connection token
// bucket, ping/pong with an idle timeout, and typed close codes.
package conn

import (
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Application close codes (4000-4999). They must stay distinguishable from a
// normal finish: a client shown "dungeon server stopped responding" on 4001
// must never mistake it for a result screen.
const (
	CloseReplaced         = 4000 // a newer socket of the same kind took over
	CloseActorUnavailable = 4001 // q: the actor stopped consuming (abort)
	CloseIdle             = 4002 // no pong / no traffic within the idle timeout
	ClosePolicy           = 4003 // too many bad or rate-limited messages
	CloseChannelGone      = 4004 // the channel expired or was disabled
	CloseShutdown         = 1001 // the gateway is going away (deploy/restart)
)

// Limits are the per-connection numbers; the strategy fills RateLimit from
// channel config.
type Limits struct {
	// MaxInbound is the largest client frame accepted (16 KB, like topic).
	MaxInbound int64
	// MaxOutbound caps a frame the gateway sends; larger ones are dropped and
	// counted rather than corrupting a client that does no reassembly.
	MaxOutbound int
	// QueueDepth is the outbound backlog per connection; beyond it the oldest
	// pending frame is dropped (snapshot semantics: newest wins).
	QueueDepth int
	// RateLimit is inbound messages per second (token bucket, burst = 2x).
	RateLimit int
	// PingInterval / IdleTimeout drive the heartbeat.
	PingInterval time.Duration
	IdleTimeout  time.Duration
	// WriteTimeout bounds one write so a stalled peer cannot block the loop.
	WriteTimeout time.Duration
}

// DefaultLimits are the settled values.
func DefaultLimits() Limits {
	return Limits{
		MaxInbound:   16 << 10,
		MaxOutbound:  32 << 10,
		QueueDepth:   256,
		RateLimit:    20,
		PingInterval: 30 * time.Second,
		IdleTimeout:  75 * time.Second,
		WriteTimeout: 10 * time.Second,
	}
}

// Hooks receive counters; nil hooks are ignored.
type Hooks struct {
	OnSent      func()
	OnDropped   func()
	OnOversized func()
	// OnQueueDepth reports the outbound backlog after each enqueue, so the
	// process can keep a high-water mark of socket buffering.
	OnQueueDepth func(depth int)
}

// Conn is one client socket.
type Conn struct {
	ID     string
	UserID string
	ws     *websocket.Conn
	limits Limits
	hooks  Hooks
	now    func() time.Time

	mu      sync.Mutex
	queue   [][]byte
	head    int
	signal  chan struct{}
	closed  bool
	code    int
	reason  string
	done    chan struct{}
	bucket  float64
	lastRef time.Time
}

// New wraps an accepted socket and starts its write loop.
func New(ws *websocket.Conn, id, userID string, limits Limits, hooks Hooks) *Conn {
	c := &Conn{ID: id, UserID: userID, ws: ws, limits: limits, hooks: hooks, now: time.Now,
		signal: make(chan struct{}, 1), done: make(chan struct{})}
	c.bucket = float64(limits.RateLimit) * 2
	c.lastRef = c.now()
	ws.SetReadLimit(limits.MaxInbound)
	_ = ws.SetReadDeadline(c.now().Add(limits.IdleTimeout))
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(c.now().Add(limits.IdleTimeout))
	})
	go c.writeLoop()
	return c
}

// Done is closed once the socket is fully closed.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Closed reports whether Close was called.
func (c *Conn) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Send marshals v and queues it. It returns false when the frame was dropped
// (oversized, or the connection is closed); a drop of an *older* frame to
// make room is reported through hooks, not the return value.
func (c *Conn) Send(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return c.SendRaw(b)
}

// SendRaw queues an already-encoded frame.
func (c *Conn) SendRaw(b []byte) bool {
	if len(b) > c.limits.MaxOutbound {
		if c.hooks.OnOversized != nil {
			c.hooks.OnOversized()
		}
		return false
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return false
	}
	if len(c.queue)-c.head >= c.limits.QueueDepth {
		// Drop the oldest: a stale position is worth less than the newest.
		c.head++
		if c.hooks.OnDropped != nil {
			c.hooks.OnDropped()
		}
	}
	c.queue = append(c.queue, b)
	if c.head > 0 && c.head*2 >= len(c.queue) {
		c.queue = append([][]byte(nil), c.queue[c.head:]...)
		c.head = 0
	}
	depth := len(c.queue) - c.head
	c.mu.Unlock()
	if c.hooks.OnQueueDepth != nil {
		c.hooks.OnQueueDepth(depth)
	}
	select {
	case c.signal <- struct{}{}:
	default:
	}
	return true
}

// Allow consumes one inbound token; false means the client is over its rate.
func (c *Conn) Allow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	elapsed := now.Sub(c.lastRef).Seconds()
	c.lastRef = now
	limit := float64(c.limits.RateLimit)
	c.bucket += elapsed * limit
	if c.bucket > limit*2 {
		c.bucket = limit * 2
	}
	if c.bucket < 1 {
		return false
	}
	c.bucket--
	return true
}

// Close ends the connection with an application code. The close frame is
// sent from the write loop after pending frames, so a final `error` or
// `party` frame queued just before still reaches the client. Idempotent.
func (c *Conn) Close(code int, reason string) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.code, c.reason = code, reason
	c.mu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

// ErrClosed is returned by ReadLoop after Close.
var ErrClosed = errors.New("connection closed")

// CloseCode returns the code Close was called with (0 while open).
func (c *Conn) CloseCode() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.code
}

// ReadLoop delivers every inbound text frame to handle until the socket
// errors or Close is called. Binary frames are refused. The handler runs on
// the reader goroutine, so it must not block on this connection's own queue.
func (c *Conn) ReadLoop(handle func(msg []byte)) error {
	defer c.Close(websocket.CloseNormalClosure, "")
	for {
		kind, b, err := c.ws.ReadMessage()
		if err != nil {
			if c.Closed() {
				return ErrClosed
			}
			var ce *websocket.CloseError
			var ne net.Error
			switch {
			case errors.As(err, &ce) && ce.Code == websocket.CloseMessageTooBig:
				c.Close(websocket.CloseMessageTooBig, "frame too large")
			case errors.As(err, &ne) && ne.Timeout():
				// No pong and no traffic within IdleTimeout: say so, or the
				// client cannot tell it from a normal finish.
				c.Close(CloseIdle, "idle")
				return ErrIdle
			}
			return err
		}
		_ = c.ws.SetReadDeadline(c.now().Add(c.limits.IdleTimeout))
		if kind != websocket.TextMessage {
			c.Close(websocket.CloseUnsupportedData, "text frames only")
			return ErrClosed
		}
		handle(b)
	}
}

// ErrIdle is returned by ReadLoop when the idle timeout closed the socket.
var ErrIdle = errors.New("idle timeout")

func (c *Conn) writeLoop() {
	defer close(c.done)
	ticker := time.NewTicker(c.limits.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(c.now().Add(c.limits.WriteTimeout))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.finish()
				return
			}
		case <-c.signal:
			for {
				c.mu.Lock()
				if c.head < len(c.queue) {
					b := c.queue[c.head]
					c.queue[c.head] = nil
					c.head++
					c.mu.Unlock()
					_ = c.ws.SetWriteDeadline(c.now().Add(c.limits.WriteTimeout))
					if err := c.ws.WriteMessage(websocket.TextMessage, b); err != nil {
						c.Close(websocket.CloseAbnormalClosure, "")
						c.finish()
						return
					}
					if c.hooks.OnSent != nil {
						c.hooks.OnSent()
					}
					continue
				}
				closed := c.closed
				c.mu.Unlock()
				if closed {
					c.finish()
					return
				}
				break
			}
		}
	}
}

func (c *Conn) finish() {
	c.mu.Lock()
	c.closed = true
	code, reason := c.code, c.reason
	c.queue, c.head = nil, 0
	c.mu.Unlock()
	if code == 0 {
		code = websocket.CloseNormalClosure
	}
	_ = c.ws.SetWriteDeadline(c.now().Add(time.Second))
	_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason))
	_ = c.ws.Close()
}

// ErrorFrame is the typed error every strategy sends.
type ErrorFrame struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// SendError queues `{type:"error", code, message}`.
func (c *Conn) SendError(code, message string) {
	c.Send(ErrorFrame{Type: "error", Code: code, Message: message})
}

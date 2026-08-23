// Package ws is a tiny WebSocket client for the match/topic protocols:
// `Sec-WebSocket-Protocol: bearer, <jwt>` carries the auth JWT and every
// frame is a JSON object with a `type` field.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type Message map[string]any

func (m Message) Type() string {
	t, _ := m["type"].(string)
	return t
}

type Conn struct {
	c    *websocket.Conn
	msgs chan Message
	errs chan error
	done chan struct{}
}

// Dial connects with the bearer subprotocol. The token is never logged.
func Dial(ctx context.Context, url, jwt string) (*Conn, error) {
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Subprotocols: []string{"bearer", jwt}}
	c, res, err := d.DialContext(ctx, url, http.Header{})
	if err != nil {
		if res != nil {
			return nil, fmt.Errorf("dial %s: %w (HTTP %d)", url, err, res.StatusCode)
		}
		return nil, fmt.Errorf("dial %s: %w", url, err)
	}
	conn := &Conn{c: c, msgs: make(chan Message, 64), errs: make(chan error, 1), done: make(chan struct{})}
	go conn.readLoop()
	return conn, nil
}

func (c *Conn) readLoop() {
	defer close(c.msgs)
	for {
		_, b, err := c.c.ReadMessage()
		if err != nil {
			c.errs <- err
			return
		}
		var m Message
		if json.Unmarshal(b, &m) != nil {
			m = Message{"type": "_raw", "data": string(b)}
		}
		select {
		case c.msgs <- m:
		case <-c.done:
			return
		}
	}
}

func (c *Conn) Send(v any) error { return c.c.WriteJSON(v) }

// Next waits for the next message; ok=false on close/timeout (err tells which).
func (c *Conn) Next(ctx context.Context, d time.Duration) (Message, bool, error) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case m, ok := <-c.msgs:
		if !ok {
			select {
			case err := <-c.errs:
				return nil, false, err
			default:
				return nil, false, fmt.Errorf("closed")
			}
		}
		return m, true, nil
	case <-t.C:
		return nil, false, nil
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
}

func (c *Conn) Close() error {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	_ = c.c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(2*time.Second))
	return c.c.Close()
}

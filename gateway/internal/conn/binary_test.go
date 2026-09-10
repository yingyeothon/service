package conn

import (
	"bytes"
	"testing"

	"github.com/gorilla/websocket"
)

// `SendBinary` writes a WebSocket **binary** frame; everything the gateway
// says itself stays text. The frame kind is per message, so a binary send
// between two text sends does not change theirs (`gateway/README.md`
// *Binary frames*).
func TestSendBinaryWritesABinaryFrame(t *testing.T) {
	c, cl := pair(t, DefaultLimits(), Hooks{})
	raw := []byte{0x00, 0xff, 0x10}
	if !c.Send(map[string]string{"type": "hello"}) || !c.SendBinary(raw) ||
		!c.Send(map[string]string{"type": "bye"}) {
		t.Fatal("send refused")
	}
	for i, want := range []struct {
		kind int
		body []byte
	}{
		{websocket.TextMessage, []byte(`{"type":"hello"}`)},
		{websocket.BinaryMessage, raw},
		{websocket.TextMessage, []byte(`{"type":"bye"}`)},
	} {
		kind, b, err := cl.ReadMessage()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if kind != want.kind || !bytes.Equal(b, want.body) {
			t.Fatalf("frame %d: kind %d body %q", i, kind, b)
		}
	}
}

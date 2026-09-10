package q

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"
	"time"
)

// `binary: true` on a `send` writes a WebSocket binary frame carrying the
// decoded bytes (`gateway/README.md` *Binary frames*, `docs/decisions.md`).
// The reason it exists: a snapshot that is already bytes costs +34 % as base64
// inside a JSON text frame, plus a decode step in every client.
func TestSendBinaryFrame(t *testing.T) {
	b, _, rdb, _ := setup(t)
	ctx := context.Background()
	a := newRec()
	if err := b.Join(ctx, "g1", "i:a", "ua", a); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for rdb.PubSubNumSub(ctx, "game:out:test:ch_q:g1").Val()["game:out:test:ch_q:g1"] == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	// Bytes no JSON string could carry as text: a NUL and a lone 0xff.
	raw := []byte{0x00, 0x01, 0xff, 0x7f, 0x00}
	enc := base64.StdEncoding.EncodeToString(raw)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":"`+enc+`"}`)
	// Malformed ones are dropped, not written as text: a client promised bytes
	// must not be handed the base64 of them, or worse, a JSON object.
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":"not base64!!"}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":{"t":1}}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":""}`)
	// A text send after them proves the bridge is still running and that the
	// two directions do not cross.
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","message":{"type":"snapshot"}}`)

	deadline = time.Now().Add(2 * time.Second)
	for len(a.all()) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	bin := a.allBinary()
	if len(bin) != 1 || !bytes.Equal(bin[0], raw) {
		t.Fatalf("binary frames: %v", bin)
	}
	// `all()` holds the enter ack plus the one text send — no base64 leaked in.
	texts := a.all()
	if got := texts[len(texts)-1]; got != `{"type":"snapshot"}` {
		t.Fatalf("text frames: %v", texts)
	}
	for _, s := range texts {
		if s == enc || s == `"`+enc+`"` {
			t.Fatalf("a binary message was written as text: %v", texts)
		}
	}
}

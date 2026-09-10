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
	// base64url, unpadded: a game whose SDK produces this must not lose the
	// frames whose bytes happen to encode a `-` or `_` while the rest arrive.
	// These three bytes are exactly such a case (`-_--` in the URL alphabet).
	urly := []byte{0xfb, 0xff, 0xbe}
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":"`+base64.RawURLEncoding.EncodeToString(urly)+`"}`)
	// Malformed ones are dropped, not written as text: a client promised bytes
	// must not be handed the base64 of them, or worse, a JSON object.
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":"not base64!!"}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":{"t":1}}`)
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","binary":true,"message":""}`)
	// A text send after them proves the bridge is still running and that the
	// two directions do not cross.
	rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"i:a","message":{"type":"snapshot"}}`)

	deadline = time.Now().Add(2 * time.Second)
	for (len(a.all()) < 1 || len(a.allBinary()) < 2) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	bin := a.allBinary()
	if len(bin) != 2 || !bytes.Equal(bin[0], raw) || !bytes.Equal(bin[1], urly) {
		t.Fatalf("binary frames: %v", bin)
	}
	// **Exactly one** text frame — the `send` above. (`enter` goes into the
	// actor's Redis queue, not to the socket.) The count is the assertion:
	// checking only that no frame equals the base64 still passes when a
	// malformed binary command falls through to a text write, which is the
	// rule this test is named after.
	texts := a.all()
	if len(texts) != 1 || texts[0] != `{"type":"snapshot"}` {
		t.Fatalf("text frames: %v", texts)
	}
}

package redisx

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newClient(t *testing.T) (*Client, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return Wrap(rdb, "test"), mr
}

func TestSessionClaimAndRelease(t *testing.T) {
	c, mr := newClient(t)
	ctx := context.Background()
	prev, err := c.ClaimSession(ctx, "lobby", "ch1", "u1", "i:c1")
	if err != nil || prev != "" {
		t.Fatalf("first claim: %q %v", prev, err)
	}
	prev, err = c.ClaimSession(ctx, "lobby", "ch1", "u1", "i:c2")
	if err != nil || prev != "i:c1" {
		t.Fatalf("second claim: %q %v", prev, err)
	}
	if ttl := mr.TTL(c.SessionKey("lobby", "ch1", "u1")); ttl <= 0 {
		t.Fatal("session has no ttl")
	}
	// The replaced socket releasing must not delete the newer binding.
	if err := c.ReleaseSession(ctx, "lobby", "ch1", "u1", "i:c1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := mr.Get(c.SessionKey("lobby", "ch1", "u1")); got != "i:c2" {
		t.Fatalf("newer binding removed: %q", got)
	}
	if err := c.ReleaseSession(ctx, "lobby", "ch1", "u1", "i:c2"); err != nil {
		t.Fatal(err)
	}
	if mr.Exists(c.SessionKey("lobby", "ch1", "u1")) {
		t.Fatal("binding not released")
	}
}

func TestPosPartyQueue(t *testing.T) {
	c, mr := newClient(t)
	ctx := context.Background()
	if err := c.SetPos(ctx, "ch1", "u1", []byte(`{"zone":"z"}`)); err != nil {
		t.Fatal(err)
	}
	if b, _ := c.GetPos(ctx, "ch1", "u1"); string(b) != `{"zone":"z"}` {
		t.Fatalf("pos: %s", b)
	}
	if b, err := c.GetPos(ctx, "ch1", "nobody"); b != nil || err != nil {
		t.Fatalf("missing pos: %s %v", b, err)
	}
	if err := c.SetParty(ctx, "ch1", "p1", []byte(`{}`), []string{"u1", "u2"}); err != nil {
		t.Fatal(err)
	}
	if p, _ := c.PartyOf(ctx, "ch1", "u2"); p != "p1" {
		t.Fatalf("partyOf: %q", p)
	}
	if ttl := mr.TTL(c.Key("partyOf", "ch1", "u2")); ttl <= 0 {
		t.Fatal("partyOf has no ttl")
	}
	_ = c.DelPartyOf(ctx, "ch1", "u2")
	if p, _ := c.PartyOf(ctx, "ch1", "u2"); p != "" {
		t.Fatal("partyOf not removed")
	}
	_ = c.DelParty(ctx, "ch1", "p1", []string{"u1"})
	if b, _ := c.GetParty(ctx, "ch1", "p1"); b != nil {
		t.Fatal("party not removed")
	}
	depth, err := c.Push(ctx, "game:test:ch:queue:g1", []byte(`{"a":1}`))
	if err != nil || depth != 1 {
		t.Fatalf("push: %d %v", depth, err)
	}
	depth, _ = c.Push(ctx, "game:test:ch:queue:g1", []byte(`{"a":2}`))
	if depth != 2 || mr.TTL("game:test:ch:queue:g1") <= 0 {
		t.Fatalf("depth %d ttl %v", depth, mr.TTL("game:test:ch:queue:g1"))
	}
	_ = c.DelRaw(ctx, "game:test:ch:queue:g1")
	if mr.Exists("game:test:ch:queue:g1") {
		t.Fatal("queue not deleted")
	}
}

func TestOpenRejectsBadURL(t *testing.T) {
	_, err := Open(context.Background(), "http://not-redis", "dev")
	if err == nil || err.Error() != "GATEWAY_REDIS_URL: not a valid redis:// URL" {
		t.Fatalf("bad url: %v", err)
	}
}

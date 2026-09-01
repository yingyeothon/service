package redisx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"reflect"
	"strings"
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

func TestClaimSessionIsOneAtomicWrite(t *testing.T) {
	c, mr := newClient(t)
	ctx := context.Background()
	// A first claim on a key that never existed must still carry the TTL, and
	// the value must be the new connection — both from the single SET.
	if _, err := c.ClaimSession(ctx, "q", "ch1", "u1", "i:c1"); err != nil {
		t.Fatal(err)
	}
	key := c.SessionKey("q", "ch1", "u1")
	if got, _ := mr.Get(key); got != "i:c1" {
		t.Fatalf("value %q", got)
	}
	if ttl := mr.TTL(key); ttl <= 0 || ttl > SessionTTL {
		t.Fatalf("ttl %v", ttl)
	}
	// Re-claiming with the same socket reports no replacement and refreshes.
	mr.FastForward(SessionTTL / 2)
	prev, err := c.ClaimSession(ctx, "q", "ch1", "u1", "i:c1")
	if err != nil || prev != "" {
		t.Fatalf("same socket: %q %v", prev, err)
	}
	if ttl := mr.TTL(key); ttl <= SessionTTL/2 {
		t.Fatalf("ttl not refreshed: %v", ttl)
	}
}

// Golden §7-4: every key the gateway writes carries a TTL. The list below is
// the exhaustive set of exported write helpers; the reflection check fails
// when a new one appears so that it gets added (and its TTL asserted) here.
func TestEveryWriteHelperLeavesATTL(t *testing.T) {
	c, mr := newClient(t)
	ctx := context.Background()
	writes := map[string]func() error{
		"ClaimSession": func() error { _, err := c.ClaimSession(ctx, "lobby", "ch", "u", "i:c"); return err },
		"TouchSession": func() error { return c.TouchSession(ctx, "lobby", "ch", "u") },
		"SetPos":       func() error { return c.SetPos(ctx, "ch", "u", []byte("{}")) },
		"SetPosBatch":  func() error { return c.SetPosBatch(ctx, "ch", map[string][]byte{"u": []byte("{}"), "v": []byte("{}")}) },
		"SetParty":     func() error { return c.SetParty(ctx, "ch", "p", []byte("{}"), []string{"u"}) },
		"Push":         func() error { _, err := c.Push(ctx, "game:test:ch:queue:g", []byte("{}")); return err },
	}
	// Checked per helper on an empty store, so two helpers sharing a key
	// (ClaimSession/TouchSession) cannot cover for each other.
	for name, fn := range writes {
		mr.FlushAll()
		if name == "TouchSession" {
			// TouchSession only refreshes; give it a key without a TTL first.
			mr.Set(c.SessionKey("lobby", "ch", "u"), "i:c")
		}
		if err := fn(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(mr.Keys()) == 0 {
			t.Errorf("%s wrote nothing", name)
		}
		for _, key := range mr.Keys() {
			if ttl := mr.TTL(key); ttl <= 0 {
				t.Errorf("%s: %s has no ttl", name, key)
			}
		}
	}
	// Reads and deletes are exempt; anything else exported must be listed.
	exempt := map[string]bool{
		"Close": true, "Ping": true, "Raw": true, "Key": true, "SessionKey": true,
		"ReleaseSession": true, "GetPos": true, "DelPos": true, "DelParty": true,
		"DelPartyOf": true, "GetParty": true, "PartyOf": true, "GetRaw": true,
		"GetRawMany": true, "DelRaw": true, "Subscribe": true,
	}
	typ := reflect.TypeOf(c)
	for i := 0; i < typ.NumMethod(); i++ {
		name := typ.Method(i).Name
		if _, ok := writes[name]; ok || exempt[name] {
			continue
		}
		t.Errorf("exported method %s is neither a listed write helper nor exempt", name)
	}
}

func TestSanitizeMasksAddresses(t *testing.T) {
	addr := &net.TCPAddr{IP: net.ParseIP("203.0.113.9"), Port: 6379}
	cases := []struct {
		err  error
		want string
	}{
		{&net.OpError{Op: "dial", Net: "tcp", Addr: addr, Err: errors.New("connection refused")}, "dial tcp: connection refused"},
		{&net.OpError{Op: "read", Net: "tcp", Addr: addr, Err: timeoutErr{}}, "read tcp: i/o timeout"},
		{&net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "redis.example.com"}}, "dial tcp: lookup: no such host"},
	}
	for _, tc := range cases {
		got := sanitize(fmt.Errorf("wrapped: %w", tc.err))
		if got.Error() != tc.want {
			t.Errorf("got %q want %q", got.Error(), tc.want)
		}
		if strings.Contains(got.Error(), "203.0.113") || strings.Contains(got.Error(), "example.com") {
			t.Errorf("address leaked: %q", got.Error())
		}
		if !errors.Is(got, tc.err) {
			t.Errorf("chain lost for %q", tc.want)
		}
	}
	plain := errors.New("NOPERM this user has no permissions")
	if sanitize(plain) != plain {
		t.Error("server replies must pass through unchanged")
	}
	if sanitize(context.DeadlineExceeded) != context.DeadlineExceeded {
		t.Error("context errors must pass through unchanged")
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestMaskAddresses(t *testing.T) {
	cases := map[string]string{
		"redis: connection pool: failed to dial after 3 attempts: dial tcp 203.0.113.9:6379: connect: connection refused": "redis: connection pool: failed to dial after 3 attempts: dial tcp <addr>: connect: connection refused",
		"pubsub: reconnecting to new endpoint redis.example.com:6379 (was [2001:db8::1]:6379)":                            "pubsub: reconnecting to new endpoint <addr> (was <addr>)",
		"discarding bad PubSub connection: EOF": "discarding bad PubSub connection: EOF",
	}
	for in, want := range cases {
		if got := MaskAddresses(in); got != want {
			t.Errorf("got %q want %q", got, want)
		}
	}
}

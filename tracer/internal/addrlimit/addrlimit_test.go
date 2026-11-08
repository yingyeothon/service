package addrlimit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientAddr(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.9")
	if got := ClientAddr(r); got != "203.0.113.9" {
		t.Fatalf("behind proxy %s", got)
	}
	r.RemoteAddr = "198.51.100.1:5000"
	if got := ClientAddr(r); got != "198.51.100.1" {
		t.Fatalf("direct peer must ignore XFF: %s", got)
	}
	r.RemoteAddr = "[2001:db8:1:2:3:4:5:6]:5000"
	if got := ClientAddr(r); got != "2001:db8:1:2::/64" {
		t.Fatalf("ipv6 /64: %s", got)
	}
}

func TestFailBuckets(t *testing.T) {
	now := time.Unix(1000, 0)
	f := NewFailBuckets(func() time.Time { return now })
	for i := 0; i < Burst; i++ {
		f.Fail("a")
	}
	if f.Allowed("a") {
		t.Fatal("drained bucket allowed")
	}
	if !f.Allowed("b") {
		t.Fatal("other address refused")
	}
	now = now.Add(2 * time.Second)
	if !f.Allowed("a") {
		t.Fatal("refill not applied")
	}
}

func TestFullMapSharesOverflowBucket(t *testing.T) {
	now := time.Unix(1000, 0)
	f := NewFailBuckets(func() time.Time { return now })
	for i := 0; i < MaxAddresses; i++ {
		addr := fmt.Sprintf("a%d", i)
		for range Burst {
			f.Fail(addr)
		}
	}
	// New addresses past the bound are limited together, never unlimited.
	for i := 0; i < Burst; i++ {
		f.Fail(fmt.Sprintf("new%d", i))
	}
	if f.Allowed("new-other") {
		t.Fatal("untracked address unlimited once the map is full")
	}
	if len(f.m) > MaxAddresses+1 {
		t.Fatalf("map grew to %d", len(f.m))
	}
}

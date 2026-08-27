package console

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const tok = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func server(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/gw/health" {
			_, _ = w.Write([]byte(`{"service":"yyt-console","gateway":true,"configured":true}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+tok {
			w.WriteHeader(401)
			return
		}
		hits.Add(1)
		switch r.URL.Path {
		case "/gw/channels/lobby_0123456789abcdef":
			_, _ = w.Write([]byte(`{"id":"lobby_0123456789abcdef","kind":"lobby","name":"l","expiresAt":9999999999,
			"config":{"authChannelId":"ch_auth","capabilities":{"pos":true,"say":["zone","user"],"party":true,"event":true,"debug":false},
			"flushIntervalMs":200,"maxMoveDelta":3,"rateLimit":20,"partySizeMax":4,"defaultZone":"Zone001","mapUrl":""},
			"authVerifyUrl":"https://auth.example.com/c/ch_auth/verify"}`))
		case "/gw/channels/q_0123456789abcdef":
			_, _ = w.Write([]byte(`{"id":"q_0123456789abcdef","kind":"q","name":"q","expiresAt":9999999999,"config":{"authChannelId":"ch_auth"},
			"authVerifyUrl":"https://auth.example.com/c/ch_auth/verify",
			"redis":{"eventKeyPrefix":"game:dev:ch_q:event:","queueKeyPrefix":"game:dev:ch_q:queue:","lockKeyPrefix":"game:dev:ch_q:lock:","awaiterKeyPrefix":"game:dev:ch_q:awaiter:","channelPrefix":"game:out:dev:ch_q:"}}`))
		case "/gw/channels/gone_0123456789abcdef":
			w.WriteHeader(410)
			_, _ = w.Write([]byte(`{"error":"gone"}`))
		case "/gw/channels/nc_0123456789abcdef":
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":"unavailable","details":{"reason":"gateway_not_configured"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestGetCachesAndDecodes(t *testing.T) {
	var hits atomic.Int32
	srv := server(t, &hits)
	defer srv.Close()
	now := time.Unix(1000, 0)
	c := New(Options{BaseURL: srv.URL + "/", Token: tok, TTL: time.Minute, Now: func() time.Time { return now }})
	ctx := context.Background()

	ch, err := c.Get(ctx, "lobby_0123456789abcdef")
	if err != nil || ch.Lobby == nil || ch.Lobby.DefaultZone != "Zone001" || !ch.Lobby.Capabilities.AllowsSay("user") || ch.Lobby.Capabilities.AllowsSay("party") {
		t.Fatalf("lobby decode: %+v %v", ch, err)
	}
	if ch.AuthChannelID != "ch_auth" {
		t.Fatal("authChannelId not lifted")
	}
	if _, err := c.Get(ctx, "lobby_0123456789abcdef"); err != nil || hits.Load() != 1 {
		t.Fatalf("cache miss: hits=%d", hits.Load())
	}
	now = now.Add(61 * time.Second)
	if _, err := c.Get(ctx, "lobby_0123456789abcdef"); err != nil || hits.Load() != 2 {
		t.Fatalf("ttl not honoured: hits=%d", hits.Load())
	}

	q, err := c.Get(ctx, "q_0123456789abcdef")
	if err != nil || q.Redis == nil || q.Redis.QueueKeyPrefix != "game:dev:ch_q:queue:" || q.AuthChannelID != "ch_auth" {
		t.Fatalf("q decode: %+v %v", q, err)
	}
	if _, err := c.Get(ctx, "gone_0123456789abcdef"); !errors.Is(err, ErrGone) {
		t.Fatalf("gone: %v", err)
	}
	if _, _ = c.Get(ctx, "gone_0123456789abcdef"); hits.Load() != 4 {
		t.Fatalf("negative answer not cached: hits=%d", hits.Load())
	}
	if _, err := c.Get(ctx, "ch_0123456789abcdef"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("404: %v", err)
	}
	if _, err := c.Get(ctx, "nc_0123456789abcdef"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("503: %v", err)
	}
	before := hits.Load()
	for _, bad := range []string{"a/b", "", "nope", "ch_ZZZZ", "lobby_" + strings.Repeat("a", 40), "Lobby_0123456789abcdef"} {
		if _, err := c.Get(ctx, bad); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%q accepted", bad)
		}
	}
	if hits.Load() != before {
		t.Fatal("malformed ids reached the console")
	}
	configured, err := c.Health(ctx)
	if err != nil || !configured {
		t.Fatalf("health: %v %v", configured, err)
	}
}

func TestUnauthorized(t *testing.T) {
	var hits atomic.Int32
	srv := server(t, &hits)
	defer srv.Close()
	wrong := strings.Repeat("abcdef0123456789", 4)
	c := New(Options{BaseURL: srv.URL, Token: wrong})
	if _, err := c.Get(context.Background(), "lobby_0123456789abcdef"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("401: %v", err)
	}
}

func TestDecodeRejects(t *testing.T) {
	bad := []string{
		`{"id":"x","kind":"auth","authVerifyUrl":"https://a/v","config":{}}`,
		`{"id":"x","kind":"lobby","config":{}}`,
		`{"id":"x","kind":"q","authVerifyUrl":"https://a/v","config":{"authChannelId":"a"}}`,
		`{"id":"x","kind":"lobby","authVerifyUrl":"file:///etc","config":{}}`,
		`not json`,
	}
	for _, b := range bad {
		if _, err := decode([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

func TestCacheBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer srv.Close()
	c := New(Options{BaseURL: srv.URL, Token: tok})
	for i := 0; i < maxCache+50; i++ {
		_, _ = c.Get(context.Background(), fmt.Sprintf("x_%016x", i))
	}
	c.mu.Lock()
	n := len(c.cache)
	c.mu.Unlock()
	if n > maxCache {
		t.Fatalf("cache grew to %d", n)
	}
}

func TestSharedFetchSurvivesCallerCancel(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		_, _ = w.Write([]byte(`{"id":"lobby_0123456789abcdef","kind":"lobby","authVerifyUrl":"https://a/v","config":{"authChannelId":"a"}}`))
	}))
	defer srv.Close()
	c := New(Options{BaseURL: srv.URL, Token: tok})
	ctx1, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := c.Get(ctx1, "lobby_0123456789abcdef"); first <- err }()
	time.Sleep(20 * time.Millisecond)
	second := make(chan error, 1)
	go func() { _, err := c.Get(context.Background(), "lobby_0123456789abcdef"); second <- err }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first caller: %v", err)
	}
	close(release)
	if err := <-second; err != nil {
		t.Fatalf("second caller failed with the first's cancel: %v", err)
	}
}

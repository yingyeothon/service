package authn

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// jwt builds an unsigned-but-well-formed token; the fake auth keys on it.
func jwt(sub string, exp int64) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	p := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":%q,"exp":%d}`, sub, exp)))
	return h + "." + p + ".sig"
}

func TestVerifyCachesUntilExp(t *testing.T) {
	var calls atomic.Int32
	now := time.Unix(1_000_000, 0)
	good := jwt("u1", now.Unix()+100)
	bad := jwt("u2", now.Unix()+100)
	// Claims say fresh, auth says expired: auth's answer wins.
	stale := jwt("u3", now.Unix()+100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.Header.Get("Authorization") {
		case "Bearer " + good:
			fmt.Fprintf(w, `{"userId":"u1","exp":%d,"channelId":"ch_auth"}`, now.Unix()+100)
		case "Bearer " + stale:
			fmt.Fprintf(w, `{"userId":"u1","exp":%d,"channelId":"ch_auth"}`, now.Unix()-1)
		default:
			w.WriteHeader(401)
		}
	}))
	defer srv.Close()
	v := New(Options{Now: func() time.Time { return now }})
	ctx := context.Background()
	url := srv.URL + "/c/ch_auth/verify"

	id, err := v.Verify(ctx, url, good)
	if err != nil || id.UserID != "u1" || id.ChannelID != "ch_auth" {
		t.Fatalf("verify: %+v %v", id, err)
	}
	if _, err := v.Verify(ctx, url, good); err != nil || calls.Load() != 1 {
		t.Fatalf("not cached: calls=%d", calls.Load())
	}
	// A different verify URL is a different cache key.
	if _, err := v.Verify(ctx, srv.URL+"/c/other/verify", good); err != nil || calls.Load() != 2 {
		t.Fatalf("url not part of key: calls=%d", calls.Load())
	}
	now = now.Add(101 * time.Second)
	if _, err := v.Verify(ctx, url, good); err != nil || calls.Load() != 3 {
		t.Fatalf("exp not honoured: calls=%d", calls.Load())
	}
	if _, err := v.Verify(ctx, url, bad); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("401: %v", err)
	}
	if _, err := v.Verify(ctx, url, bad); !errors.Is(err, ErrUnauthorized) || calls.Load() != 4 {
		t.Fatalf("negative not cached: calls=%d", calls.Load())
	}
	now = now.Add(negativeTTL + time.Second)
	if _, err := v.Verify(ctx, url, bad); !errors.Is(err, ErrUnauthorized) || calls.Load() != 5 {
		t.Fatalf("negative cache never expires: calls=%d", calls.Load())
	}
	if _, err := v.Verify(ctx, url, stale); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expired token accepted: %v", err)
	}
	for _, junk := range []string{"", "with space", "tab\tx", "ctl\x01", "not-a-jwt", "a.b", "a.!!.c", jwt("", now.Unix()+100), jwt("u9", now.Unix()-3600)} {
		if _, err := v.Verify(ctx, url, junk); !errors.Is(err, ErrUnauthorized) || calls.Load() != 6 {
			t.Fatalf("%q reached auth", junk)
		}
	}
}

func TestVerifyDedupesBurst(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-release
		fmt.Fprintf(w, `{"userId":"u1","exp":%d}`, time.Now().Unix()+60)
	}))
	defer srv.Close()
	v := New(Options{})
	same := jwt("u1", time.Now().Unix()+60)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := v.Verify(context.Background(), srv.URL, same); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("burst not deduped: %d calls", calls.Load())
	}
}

func TestVerifyBudgetFailsFast(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(401)
	}))
	defer srv.Close()
	v := New(Options{})
	exp := time.Now().Unix() + 60
	var wg sync.WaitGroup
	for i := 0; i < maxInflight; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = v.Verify(context.Background(), srv.URL, jwt(fmt.Sprintf("u%d", i), exp))
		}(i)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := v.Verify(context.Background(), srv.URL, jwt("extra", exp)); !errors.Is(err, ErrBusy) {
		t.Fatalf("over budget: %v", err)
	}
	close(release)
	wg.Wait()
	if _, err := v.Verify(context.Background(), srv.URL, jwt("after", exp)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("budget not released: %v", err)
	}
}

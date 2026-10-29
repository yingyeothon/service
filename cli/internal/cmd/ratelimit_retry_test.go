package cmd

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
)

// The console's per-member write slot refuses before any write with
// `rate_limited` + `retryAfterMs`; the client waits that out (3 times, at most
// 5 s in total) and repeats nothing else.
func TestRateLimitedRetry(t *testing.T) {
	var waits []time.Duration
	prev := sleepFor
	sleepFor = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	t.Cleanup(func() { sleepFor = prev })

	slot := func(n int) func(recorded) (int, any) {
		calls := 0
		return func(recorded) (int, any) {
			calls++
			if calls <= n {
				return 429, apiErr("rate_limited", "too many writes; slow down", map[string]any{"retryAfterMs": 500})
			}
			return 204, nil
		}
	}
	countPuts := func(f *fakeConsole) int {
		n := 0
		for _, r := range f.reqs {
			if r.Method == "DELETE" {
				n++
			}
		}
		return n
	}

	// Two refusals, then success: three requests, two stderr lines.
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"DELETE /channels/auth_1": slot(2),
	}, nil, nil, nil))
	_, errOut, err := run(t, f, "channels", "delete", "auth_1")
	if err != nil {
		t.Fatalf("err=%v stderr=%s", err, errOut)
	}
	if countPuts(f) != 3 || len(waits) != 2 || waits[0] != 500*time.Millisecond {
		t.Fatalf("requests=%d waits=%v", countPuts(f), waits)
	}
	if strings.Count(errOut, "rate_limited: retrying in 500ms") != 2 {
		t.Fatalf("stderr=%q", errOut)
	}

	// Past the 3 retries: the refusal is the result (exit 2).
	waits = nil
	f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"DELETE /channels/auth_1": slot(10),
	}, nil, nil, nil))
	_, _, err = run(t, f, "channels", "delete", "auth_1")
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "rate_limited" || countPuts(f) != 4 {
		t.Fatalf("err=%v requests=%d", err, countPuts(f))
	}

	// Never repeated: a 429 of another code or without a hint, a 409, a 5xx.
	for _, tc := range []struct {
		status int
		body   any
	}{
		{429, apiErr("rate_limited", "recently", map[string]any{"retryAt": 1756600000})},
		{429, apiErr("too_many", "cap", map[string]any{"retryAfterMs": 500})},
		{409, apiErr("conflict", "busy", map[string]any{"retryAfterMs": 500})},
		{503, apiErr("unavailable", "down", map[string]any{"retryAfterMs": 500})},
	} {
		waits = nil
		tc := tc
		f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
			"DELETE /channels/auth_1": func(recorded) (int, any) { return tc.status, tc.body },
		}, nil, nil, nil))
		if _, _, err := run(t, f, "channels", "delete", "auth_1"); err == nil || countPuts(f) != 1 || len(waits) != 0 {
			t.Fatalf("%d %v: err=%v requests=%d", tc.status, tc.body, err, countPuts(f))
		}
	}

	// Opt-outs: the flag and the environment.
	for _, args := range [][]string{{"--no-retry", "channels", "delete", "auth_1"}, {"channels", "delete", "auth_1"}} {
		if len(args) == 3 {
			t.Setenv("YYT_NO_RETRY", "1")
		}
		f = newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
			"DELETE /channels/auth_1": slot(1),
		}, nil, nil, nil))
		if _, _, err := run(t, f, args...); err == nil || countPuts(f) != 1 {
			t.Fatalf("%v: err=%v requests=%d", args, err, countPuts(f))
		}
	}
}

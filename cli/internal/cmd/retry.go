package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"sync"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
)

// retryPolicy retries a call that failed for a reason a later attempt can
// fix: a network error, a 429 or a 5xx. Backoff doubles from `base` up to
// `max` with full jitter, and a server hint (`details.retryAfterMs`, the
// Retry-After header) is honoured when it asks for longer.
type retryPolicy struct {
	attempts  int
	base, max time.Duration
	// classify overrides `retryable` (nil = it).
	classify func(error) (bool, time.Duration)
}

var defaultRetry = retryPolicy{attempts: 5, base: 500 * time.Millisecond, max: 8 * time.Second}

// presignRetry retries a presign only when the console refused it before
// doing anything (429). A presign inserts its reservations before it
// answers, so after a transport error or a 5xx the grants may exist, and a
// second call would reserve the same bytes again for an hour.
var presignRetry = retryPolicy{attempts: 5, base: 500 * time.Millisecond, max: 8 * time.Second, classify: rateLimitedOnly}

func rateLimitedOnly(err error) (bool, time.Duration) {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status == 429 {
		return retryable(err)
	}
	return false, 0
}

// sleepFor waits `d` unless the context ends first. Tests replace it so a
// retry costs no wall-clock time.
var sleepFor = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// httpStatusError is a non-API HTTP failure (a presigned PUT or a CDN GET),
// kept typed so the retry policy can read its status.
type httpStatusError struct {
	Op         string
	Status     int
	RetryAfter time.Duration
}

func (e *httpStatusError) Error() string { return fmt.Sprintf("%s failed: HTTP %d", e.Op, e.Status) }

// retryable says whether err is worth another attempt, and the least the
// server asked to wait.
func retryable(err error) (bool, time.Duration) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false, 0
	}
	var ae *api.Error
	if errors.As(err, &ae) {
		if ae.Status != 429 && ae.Status < 500 {
			return false, 0
		}
		wait := ae.RetryAfter
		var d struct {
			RetryAfterMs int64 `json:"retryAfterMs"`
		}
		if len(ae.Details) > 0 && json.Unmarshal(ae.Details, &d) == nil && d.RetryAfterMs > 0 {
			if hint := time.Duration(d.RetryAfterMs) * time.Millisecond; hint > wait {
				wait = hint
			}
		}
		return true, wait
	}
	var he *httpStatusError
	if errors.As(err, &he) {
		return he.Status == 429 || he.Status >= 500, he.RetryAfter
	}
	// Every transport failure from net/http is a *url.Error, which is a
	// net.Error; a body cut short is io.ErrUnexpectedEOF. A decode error or
	// a local mistake is neither.
	var ne net.Error
	return errors.As(err, &ne) || errors.Is(err, io.ErrUnexpectedEOF), 0
}

// do runs fn until it succeeds, fails for good, or runs out of attempts.
func (p retryPolicy) do(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < p.attempts; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		classify := p.classify
		if classify == nil {
			classify = retryable
		}
		again, hint := classify(err)
		if !again || attempt == p.attempts-1 {
			return err
		}
		backoff := p.base << attempt
		if backoff > p.max || backoff <= 0 {
			backoff = p.max
		}
		wait := time.Duration(rand.Int64N(int64(backoff) + 1))
		if hint > wait {
			wait = hint
		}
		if err := sleepFor(ctx, wait); err != nil {
			return err
		}
	}
	return err
}

// rateLimiter spaces calls at least `every` apart across goroutines: a sync
// of thousands of files must not spend the stage's shared request budget.
type rateLimiter struct {
	mu    sync.Mutex
	every time.Duration
	next  time.Time
	now   func() time.Time
}

func newRateLimiter(perSec float64) *rateLimiter {
	r := &rateLimiter{now: time.Now}
	if perSec > 0 {
		r.every = time.Duration(float64(time.Second) / perSec)
	}
	return r
}

func (r *rateLimiter) wait(ctx context.Context) error {
	if r == nil || r.every == 0 {
		return nil
	}
	r.mu.Lock()
	now := r.now()
	at := r.next
	if at.Before(now) {
		at = now
	}
	r.next = at.Add(r.every)
	r.mu.Unlock()
	if d := at.Sub(now); d > 0 {
		return sleepFor(ctx, d)
	}
	return nil
}

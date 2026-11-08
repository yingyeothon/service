// Package addrlimit keys requests by client address (the last
// `X-Forwarded-For` entry behind the loopback proxy, IPv6 by /64) and keeps a
// per-address token bucket on authentication failures, so guessed write keys
// and read tokens never become one console call each (docs/tracer.md
// _Principals_, _Ingest_).
package addrlimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Bucket shape: a burst of failures, then one more every two seconds.
const (
	Burst        = 30
	RefillPerSec = 0.5
	MaxAddresses = 10_000
)

// overflowKey is the shared bucket of addresses the full map cannot track.
const overflowKey = "_overflow"

// NewFailBuckets builds an empty set; now defaults to time.Now.
func NewFailBuckets(now func() time.Time) *FailBuckets {
	if now == nil {
		now = time.Now
	}
	return &FailBuckets{m: map[string]*bucket{}, now: now}
}

// ClientAddr is the bucket key of a request.
func ClientAddr(r *http.Request) string {
	return addrKey(peerAddr(r))
}

func addrKey(host string) string {
	ip := net.ParseIP(host)
	if ip == nil || ip.To4() != nil {
		return host
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

func peerAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(last) != nil {
				return last
			}
		}
	}
	return host
}

// FailBuckets is a per-address token bucket on authentication failures.
type FailBuckets struct {
	mu  sync.Mutex
	m   map[string]*bucket
	now func() time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

func (f *FailBuckets) take(addr string, spend bool) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	b, ok := f.m[addr]
	if !ok && len(f.m) >= MaxAddresses && spend {
		// Evict refilled buckets first; never wipe the drained ones an
		// attacker would like reset.
		for k, v := range f.m {
			if k != overflowKey && v.tokens+now.Sub(v.at).Seconds()*RefillPerSec >= Burst {
				delete(f.m, k)
			}
		}
	}
	if !ok && len(f.m) >= MaxAddresses {
		// Full of drained buckets (many addresses failing at once): every
		// untracked address shares one bucket rather than going unlimited.
		b, ok = f.m[overflowKey]
		if !ok && spend {
			b = &bucket{tokens: Burst, at: now}
			f.m[overflowKey] = b
			ok = true
		}
	}
	if !ok {
		if !spend {
			return true
		}
		b = &bucket{tokens: Burst, at: now}
		f.m[addr] = b
	}
	b.tokens = min(Burst, b.tokens+now.Sub(b.at).Seconds()*RefillPerSec)
	b.at = now
	if !spend {
		return b.tokens >= 1
	}
	b.tokens = max(0, b.tokens-1)
	return true
}

// Allowed reports whether addr may still try (without spending).
func (f *FailBuckets) Allowed(addr string) bool { return f.take(addr, false) }

// Fail spends one token of addr.
func (f *FailBuckets) Fail(addr string) { f.take(addr, true) }

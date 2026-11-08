// Package resource answers "which tracer resource is this, and what may it
// send". Server mode asks the console (`GET /tr/resources/{id}`, todo/85 P5);
// local mode reads `tracer.json`. tracer holds no resource list of its own.
package resource

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"

	"github.com/yingyeothon/service/tracer/internal/config"
)

// ErrNotFound means the console does not know the id (or it is deleted).
var ErrNotFound = errors.New("resource: not found")

// Resource is what ingest needs to accept an envelope.
type Resource struct {
	ID             string
	WriteKeySha256 [32]byte
	// State is "active" for an ingestible resource.
	State string
	// DailyBytes is the effective `tracer.dailyBytes` quota.
	DailyBytes int64
}

// Active reports whether ingest may store for the resource.
func (r Resource) Active() bool { return r.State == "active" }

// KeyMatches compares sha256(key) with the stored digest in constant time.
func (r Resource) KeyMatches(key string) bool {
	if key == "" {
		return false
	}
	sum := sha256.Sum256([]byte(key))
	return subtle.ConstantTimeCompare(sum[:], r.WriteKeySha256[:]) == 1
}

// Source resolves resources by id.
type Source interface {
	Lookup(ctx context.Context, id string) (Resource, error)
}

// Local serves the resources of `tracer.json`.
type Local struct {
	byID map[string]Resource
}

// NewLocal builds a Source from a parsed local file.
func NewLocal(f *config.LocalFile) *Local {
	l := &Local{byID: map[string]Resource{}}
	for _, r := range f.Resources {
		l.byID[r.ID] = Resource{ID: r.ID, WriteKeySha256: f.KeyHashes[r.ID], State: "active", DailyBytes: r.DailyBytes}
	}
	return l
}

// Lookup implements Source.
func (l *Local) Lookup(_ context.Context, id string) (Resource, error) {
	r, ok := l.byID[id]
	if !ok {
		return Resource{}, ErrNotFound
	}
	return r, nil
}

// IDs lists the configured resource ids (local mode metrics).
func (l *Local) IDs() []string {
	out := make([]string, 0, len(l.byID))
	for id := range l.byID {
		out = append(out, id)
	}
	return out
}

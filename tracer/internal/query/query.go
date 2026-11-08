// Package query backs the read API (`GET /v1/{trc}/…`, docs/tracer.md): bounded,
// read-only filters over the store, consumed by `yyt tracer` and the
// tracer-debug skill.
package query

import (
	"errors"
	"time"
)

// ErrNotImplemented is returned until the read API lands (todo/85-tracer.md).
var ErrNotImplemented = errors.New("query: not implemented")

// Filter selects rows. Zero values mean "no filter".
type Filter struct {
	Project  string        // project slug
	Kind     string        // events | breadcrumbs | logs | drops
	Since    time.Duration // look-back window from now
	Level    string
	Category string // breadcrumb category, e.g. board.pointer
	Text     string // substring match on message/body
	Limit    int
}

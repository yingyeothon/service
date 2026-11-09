// Package metrics holds tracer's process-wide counters and gauges, rendered
// as JSON by `GET /metrics` in the gateway's shape (counters, gauges,
// runtime). The ops agent scrapes the public part; the per-resource slice
// names resource ids and is served only with the `tracer-token` bearer.
package metrics

import (
	"encoding/json"
	"runtime"
	"sync"
	"sync/atomic"
)

// Counters are monotonically increasing.
type Counters struct {
	EnvelopesAccepted atomic.Int64
	EnvelopesRejected atomic.Int64
	Rejected401       atomic.Int64
	Rejected413       atomic.Int64
	Rejected429       atomic.Int64
	Rejected503       atomic.Int64
	RejectedOther     atomic.Int64
	// ItemsStored / ItemsDropped count items of accepted envelopes (stored
	// rows net of duplicates; dropped = unknown, not_stored, too_large,
	// invalid, quota_attachment). Refused envelopes are EnvelopesRejected.
	ItemsStored    atomic.Int64
	ItemsDropped   atomic.Int64
	BytesIngested  atomic.Int64
	Duplicates     atomic.Int64
	ConfigFetches  atomic.Int64
	ConfigStale    atomic.Int64
	AuthzCalls     atomic.Int64
	AuthzCacheHits atomic.Int64
	ReadRequests   atomic.Int64
	ReadRejected   atomic.Int64
	// Read requests past the token shape check, by credential: a `yyt_`
	// API token or a `trr_` console read ticket (the SPA).
	ReadTokenRequests  atomic.Int64
	ReadTicketRequests atomic.Int64
	StoreErrors        atomic.Int64
	// Retention: rows removed by age or by the stage cap, and orphan files.
	RetentionRows    atomic.Int64
	RetentionCapRows atomic.Int64
	OrphanBlobs      atomic.Int64
	RetentionErrors  atomic.Int64
	// PurgedRows: rows of console-deleted resources removed (server mode).
	PurgedRows atomic.Int64
}

// Gauges are current values.
type Gauges struct {
	InFlight        atomic.Int64
	DBBytes         atomic.Int64
	WALBytes        atomic.Int64
	BlobBytes       atomic.Int64
	VolumeFreeBytes atomic.Int64
	VolumeUsedPct   atomic.Int64
	StageBytesCap   atomic.Int64
	WriterTxMaxUs   atomic.Int64
	// RetentionLastOkMs is when the last retention pass completed (0 = none yet).
	RetentionLastOkMs atomic.Int64
}

// CountRejection files a refused envelope under its status.
func (c *Counters) CountRejection(status int) {
	c.EnvelopesRejected.Add(1)
	switch status {
	case 401:
		c.Rejected401.Add(1)
	case 413:
		c.Rejected413.Add(1)
	case 429:
		c.Rejected429.Add(1)
	case 503:
		c.Rejected503.Add(1)
	default:
		c.RejectedOther.Add(1)
	}
}

// ResourceStats is the per-resource slice (operator only).
type ResourceStats struct {
	Accepted   atomic.Int64
	Refused    atomic.Int64
	Dropped    atomic.Int64
	Bytes      atomic.Int64
	QuotaHits  atomic.Int64 // envelopes refused (429) or stripped of attachments by the quota
	LastSeenMs atomic.Int64
}

// Registry is the single instance the process shares.
type Registry struct {
	Counters  Counters
	Gauges    Gauges
	mu        sync.Mutex
	resources map[string]*ResourceStats
}

// New returns an empty registry.
func New() *Registry { return &Registry{resources: map[string]*ResourceStats{}} }

// maxResources bounds the per-resource map: ids come from authenticated
// envelopes only, but a bound keeps a bug from growing it without end.
const maxResources = 4096

// Resource returns a resource's bucket, creating it on first use. Past the
// bound it returns a shared overflow bucket.
func (r *Registry) Resource(id string) *ResourceStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.resources[id]
	if !ok {
		if len(r.resources) >= maxResources {
			id = "_overflow"
			if s, ok = r.resources[id]; ok {
				return s
			}
		}
		s = &ResourceStats{}
		r.resources[id] = s
	}
	return s
}

// Forget drops a resource's bucket (its data was purged).
func (r *Registry) Forget(id string) {
	r.mu.Lock()
	delete(r.resources, id)
	r.mu.Unlock()
}

type snapshot struct {
	Counters  map[string]int64            `json:"counters"`
	Gauges    map[string]int64            `json:"gauges"`
	Runtime   map[string]int64            `json:"runtime"`
	Resources map[string]map[string]int64 `json:"resources,omitempty"`
}

// MarshalJSON renders the public numbers (no resource ids).
func (r *Registry) MarshalJSON() ([]byte, error) { return json.Marshal(r.snapshot(false)) }

// Detailed adds the per-resource slice (served only to the operator bearer).
func (r *Registry) Detailed() any { return r.snapshot(true) }

func (r *Registry) snapshot(detail bool) snapshot {
	c, g := &r.Counters, &r.Gauges
	s := snapshot{
		Counters: map[string]int64{
			"envelopesAccepted":  c.EnvelopesAccepted.Load(),
			"envelopesRejected":  c.EnvelopesRejected.Load(),
			"rejected401":        c.Rejected401.Load(),
			"rejected413":        c.Rejected413.Load(),
			"rejected429":        c.Rejected429.Load(),
			"rejected503":        c.Rejected503.Load(),
			"rejectedOther":      c.RejectedOther.Load(),
			"itemsStored":        c.ItemsStored.Load(),
			"itemsDropped":       c.ItemsDropped.Load(),
			"bytesIngested":      c.BytesIngested.Load(),
			"duplicates":         c.Duplicates.Load(),
			"configFetches":      c.ConfigFetches.Load(),
			"configStale":        c.ConfigStale.Load(),
			"authzCalls":         c.AuthzCalls.Load(),
			"authzCacheHits":     c.AuthzCacheHits.Load(),
			"readRequests":       c.ReadRequests.Load(),
			"readRejected":       c.ReadRejected.Load(),
			"readTokenRequests":  c.ReadTokenRequests.Load(),
			"readTicketRequests": c.ReadTicketRequests.Load(),
			"storeErrors":        c.StoreErrors.Load(),
			"retentionRows":      c.RetentionRows.Load(),
			"retentionCapRows":   c.RetentionCapRows.Load(),
			"orphanBlobs":        c.OrphanBlobs.Load(),
			"retentionErrors":    c.RetentionErrors.Load(),
			"purgedRows":         c.PurgedRows.Load(),
		},
		Gauges: map[string]int64{
			"inFlight":          g.InFlight.Load(),
			"dbBytes":           g.DBBytes.Load(),
			"walBytes":          g.WALBytes.Load(),
			"blobBytes":         g.BlobBytes.Load(),
			"volumeFreeBytes":   g.VolumeFreeBytes.Load(),
			"volumeUsedPct":     g.VolumeUsedPct.Load(),
			"stageBytesCap":     g.StageBytesCap.Load(),
			"writerTxMaxUs":     g.WriterTxMaxUs.Load(),
			"retentionLastOkMs": g.RetentionLastOkMs.Load(),
		},
		Runtime: runtimeStats(),
	}
	if !detail {
		return s
	}
	s.Resources = map[string]map[string]int64{}
	r.mu.Lock()
	for id, rs := range r.resources {
		s.Resources[id] = map[string]int64{
			"accepted":   rs.Accepted.Load(),
			"refused":    rs.Refused.Load(),
			"dropped":    rs.Dropped.Load(),
			"bytes":      rs.Bytes.Load(),
			"quotaHits":  rs.QuotaHits.Load(),
			"lastSeenMs": rs.LastSeenMs.Load(),
		}
	}
	r.mu.Unlock()
	return s
}

// runtimeStats answers "how close is the process to its 64 MB cap".
func runtimeStats() map[string]int64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return map[string]int64{
		"heapAllocBytes": int64(m.HeapAlloc),
		"sysBytes":       int64(m.Sys),
		"goroutines":     int64(runtime.NumGoroutine()),
		"numGC":          int64(m.NumGC),
	}
}

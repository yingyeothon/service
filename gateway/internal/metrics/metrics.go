// Package metrics holds the gateway's process-wide counters and gauges. They
// are plain atomics rendered as JSON by `/metrics`; an external check scrapes
// that endpoint and alarms into the existing SNS topic (`todo/14` §2.8), so
// there is no Prometheus client and no per-user label — the value set is
// small enough to read by eye.
package metrics

import (
	"encoding/json"
	"runtime"
	"sync"
	"sync/atomic"
)

// Counters are monotonically increasing.
type Counters struct {
	ConnectionsAccepted atomic.Int64 `json:"connectionsAccepted"`
	ConnectionsRejected atomic.Int64 `json:"connectionsRejected"`
	InboundMessages     atomic.Int64 `json:"inboundMessages"`
	OutboundFrames      atomic.Int64 `json:"outboundFrames"`
	DroppedFrames       atomic.Int64 `json:"droppedFrames"`
	OversizedFrames     atomic.Int64 `json:"oversizedFrames"`
	RateLimited         atomic.Int64 `json:"rateLimited"`
	BadMessages         atomic.Int64 `json:"badMessages"`
	VerifyCalls         atomic.Int64 `json:"verifyCalls"`
	VerifyCacheHits     atomic.Int64 `json:"verifyCacheHits"`
	ConfigFetches       atomic.Int64 `json:"configFetches"`
	QueuePushes         atomic.Int64 `json:"queuePushes"`
	Aborts              atomic.Int64 `json:"aborts"`
	SessionsReplaced    atomic.Int64 `json:"sessionsReplaced"`
	RedisErrors         atomic.Int64 `json:"redisErrors"`
	// `GET /parties/{id}`: answered rosters and refusals, so an operator can
	// see whether a game's entry API reaches the gateway at all.
	PartyReads    atomic.Int64 `json:"partyReads"`
	PartyRejected atomic.Int64 `json:"partyRejected"`
	// Rejected handshakes by HTTP status, so a 401 flood and a 502 storm
	// look different.
	Rejected401   atomic.Int64
	Rejected403   atomic.Int64
	Rejected404   atomic.Int64
	Rejected429   atomic.Int64
	Rejected5xx   atomic.Int64
	RejectedOther atomic.Int64
}

// Gauges are current values.
type Gauges struct {
	Connections   atomic.Int64 `json:"connections"`
	LobbyChannels atomic.Int64 `json:"lobbyChannels"`
	Games         atomic.Int64 `json:"games"`
	Subscriptions atomic.Int64 `json:"subscriptions"`
	Parties       atomic.Int64 `json:"parties"`
	// OutboundQueueMax is the deepest per-socket backlog seen since start:
	// the number that says a client is not keeping up before drops begin.
	OutboundQueueMax atomic.Int64 `json:"outboundQueueMax"`
	// LastAbortUnix is when the last actor abort happened (0 = never).
	LastAbortUnix atomic.Int64 `json:"lastAbortUnix"`
}

// RecordQueueDepth raises OutboundQueueMax if depth is a new high.
func (g *Gauges) RecordQueueDepth(depth int) {
	d := int64(depth)
	for {
		cur := g.OutboundQueueMax.Load()
		if d <= cur || g.OutboundQueueMax.CompareAndSwap(cur, d) {
			return
		}
	}
}

// CountRejection files a refused handshake under its status.
func (c *Counters) CountRejection(status int) {
	c.ConnectionsRejected.Add(1)
	switch {
	case status == 401:
		c.Rejected401.Add(1)
	case status == 403:
		c.Rejected403.Add(1)
	case status == 404:
		c.Rejected404.Add(1)
	case status == 429:
		c.Rejected429.Add(1)
	case status >= 500:
		c.Rejected5xx.Add(1)
	default:
		c.RejectedOther.Add(1)
	}
}

// Registry is the single instance the process shares.
type Registry struct {
	Counters Counters
	Gauges   Gauges
	mu       sync.Mutex
	channels map[string]*ChannelStats
}

// ChannelStats is the per-channel slice of the same numbers.
type ChannelStats struct {
	Connections   atomic.Int64 `json:"connections"`
	Inbound       atomic.Int64 `json:"inbound"`
	Outbound      atomic.Int64 `json:"outbound"`
	Dropped       atomic.Int64 `json:"dropped"`
	QueueDepthMax atomic.Int64 `json:"queueDepthMax"`
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{channels: map[string]*ChannelStats{}}
}

// Channel returns the stats bucket of a channel, creating it on first use.
func (r *Registry) Channel(id string) *ChannelStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.channels[id]
	if !ok {
		s = &ChannelStats{}
		r.channels[id] = s
	}
	return s
}

// Forget drops a channel's bucket once it has no connections, so a
// week of one-off channels does not accumulate.
func (r *Registry) Forget(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.channels, id)
}

type snapshot struct {
	Counters map[string]int64            `json:"counters"`
	Gauges   map[string]int64            `json:"gauges"`
	Runtime  map[string]int64            `json:"runtime"`
	Channels map[string]map[string]int64 `json:"channels"`
}

// MarshalJSON renders the process-wide numbers; per-channel buckets are
// included only through Detailed, because channel ids are half of what an
// attacker needs to target a lobby and `/metrics` is on the public host.
func (r *Registry) MarshalJSON() ([]byte, error) {
	return json.Marshal(r.snapshot(false))
}

// Detailed adds the per-channel buckets (served only to the operator).
func (r *Registry) Detailed() any { return r.snapshot(true) }

func (r *Registry) snapshot(channels bool) snapshot {
	c := &r.Counters
	g := &r.Gauges
	s := snapshot{
		Counters: map[string]int64{
			"connectionsAccepted": c.ConnectionsAccepted.Load(),
			"connectionsRejected": c.ConnectionsRejected.Load(),
			"inboundMessages":     c.InboundMessages.Load(),
			"outboundFrames":      c.OutboundFrames.Load(),
			"droppedFrames":       c.DroppedFrames.Load(),
			"oversizedFrames":     c.OversizedFrames.Load(),
			"rateLimited":         c.RateLimited.Load(),
			"badMessages":         c.BadMessages.Load(),
			"verifyCalls":         c.VerifyCalls.Load(),
			"verifyCacheHits":     c.VerifyCacheHits.Load(),
			"configFetches":       c.ConfigFetches.Load(),
			"queuePushes":         c.QueuePushes.Load(),
			"aborts":              c.Aborts.Load(),
			"sessionsReplaced":    c.SessionsReplaced.Load(),
			"redisErrors":         c.RedisErrors.Load(),
			"partyReads":          c.PartyReads.Load(),
			"partyRejected":       c.PartyRejected.Load(),
			"rejected401":         c.Rejected401.Load(),
			"rejected403":         c.Rejected403.Load(),
			"rejected404":         c.Rejected404.Load(),
			"rejected429":         c.Rejected429.Load(),
			"rejected5xx":         c.Rejected5xx.Load(),
			"rejectedOther":       c.RejectedOther.Load(),
		},
		Gauges: map[string]int64{
			"connections":      g.Connections.Load(),
			"lobbyChannels":    g.LobbyChannels.Load(),
			"games":            g.Games.Load(),
			"subscriptions":    g.Subscriptions.Load(),
			"parties":          g.Parties.Load(),
			"outboundQueueMax": g.OutboundQueueMax.Load(),
			"lastAbortUnix":    g.LastAbortUnix.Load(),
		},
		Runtime: runtimeStats(),
	}
	if !channels {
		return s
	}
	s.Channels = map[string]map[string]int64{}
	r.mu.Lock()
	for id, ch := range r.channels {
		s.Channels[id] = map[string]int64{
			"connections":   ch.Connections.Load(),
			"inbound":       ch.Inbound.Load(),
			"outbound":      ch.Outbound.Load(),
			"dropped":       ch.Dropped.Load(),
			"queueDepthMax": ch.QueueDepthMax.Load(),
		}
	}
	r.mu.Unlock()
	return s
}

// runtimeStats is the 256 MB question: how close is the process to the cap.
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

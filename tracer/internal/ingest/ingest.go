// Package ingest is the envelope surface (`POST /api/{trc}/envelope/` and the
// legacy `/store/`). It authenticates the DSN write key against the resource's
// `writeKeySha256`, applies the refusal order of docs/tracer.md _Ingest_ and
// _Limits and raise requests_, streams the body through the envelope reader,
// writes attachments to blob files and hands one batch per envelope to the
// store writer. The write key never authorizes any read.
package ingest

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yingyeothon/service/tracer/internal/addrlimit"
	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/envelope"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/normalize"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/store"
)

// Defaults (docs/tracer.md _Ingest_, _Wire contract_).
const (
	DefaultMaxBodyBytes     = 20 << 20 // as sent (compressed)
	DefaultMaxDecompressed  = 20 << 20
	DefaultMaxJSONItem      = 1 << 20 // event, transaction, log container, session …
	DefaultInFlight         = 4
	DefaultInFlightWait     = 2 * time.Second
	QuotaRetryAfterSeconds  = 300
	refusedQuotaPercent     = 120
	failRetryAfterSeconds   = 60
	envelopeItemForRefusals = "envelope"
	unknownItemType         = "unknown"

	// Per-envelope bounds: what one envelope may keep in memory and add as
	// rows/files (a real SDK envelope has one event and a few attachments).
	MaxItemsPerEnvelope       = 1000
	MaxEventItemsPerEnvelope  = 10 // event, feedback, transaction
	MaxAttachmentsPerEnvelope = 20
	MaxSessionsPerEnvelope    = 100
	MaxLogRowsPerEnvelope     = 5000
	MaxKeptBytesPerEnvelope   = 2 << 20 // JSON payloads held until commit
	// RowOverhead is charged per stored row on top of its payload bytes, so
	// the quota and the stage cap follow disk growth, not just payload size.
	RowOverhead = 256
	// MaxInFlightPerAddress keeps one address from holding every slot.
	MaxInFlightPerAddress = 2
	dropFlushInterval     = 10 * time.Second

	// Slow bodies (docs/tracer.md _Ingest_): a shared slot is taken only once
	// the first body byte arrived (within DefaultBodyFirstByteWait); holding
	// it then needs DefaultBodyMinRate on average after DefaultBodyGrace, and
	// never longer than DefaultBodyMaxWait (the server's ReadTimeout, which a
	// per-request read deadline replaces).
	DefaultBodyFirstByteWait = 10 * time.Second
	// 8 KiB/s after 20 s lets a 64 kbit/s phone send ~480 KiB inside the cap;
	// the first-byte gate and the cap do the slot protection.
	DefaultBodyGrace   = 20 * time.Second
	DefaultBodyMinRate = 8 << 10 // bytes per second
	DefaultBodyMaxWait = 60 * time.Second
	// slowRetryAfterSeconds spaces a slow client's retries (no tight loop on a bad link).
	slowRetryAfterSeconds = 60
)

// Writer is the store writer (store.Writer).
type Writer interface {
	Write(ctx context.Context, b *store.Batch) (store.Result, error)
}

// Capacity is the stage byte cap and volume line (capacity.Capacity).
type Capacity interface {
	Allow(n int64) bool
	Add(n int64)
}

// Options configures a Handler.
type Options struct {
	Source  resource.Source
	Metrics *metrics.Registry
	Writer  Writer
	// Capacity nil = unlimited (tests only).
	Capacity Capacity
	// DailyBytes loads a resource's counter for a UTC day (store.DailyBytes).
	DailyBytes func(ctx context.Context, resource, day string) (int64, bool, error)
	BlobDir    string

	MaxBodyBytes    int64
	MaxDecompressed int64
	MaxJSONItem     int64
	InFlight        int
	InFlightWait    time.Duration
	// Body pacing; zero = the Default* values above.
	BodyFirstByteWait time.Duration
	BodyGrace         time.Duration
	BodyMinRate       int64
	BodyMaxWait       time.Duration
	// DumpDir (local mode only) receives each accepted raw request instead of storing it.
	DumpDir string
	Log     *slog.Logger
	Now     func() time.Time
	// Fails limits failed authentications per client address (default: own set).
	Fails *addrlimit.FailBuckets
}

// Handler serves the ingest routes.
type Handler struct {
	opt     Options
	mux     *http.ServeMux
	dumps   atomic.Int64
	sem     chan struct{}
	quota   *quotaTracker
	fails   *addrlimit.FailBuckets
	perAddr *addrSlots
	refusal *dropCounter
}

// New builds the ingest handler.
func New(opt Options) *Handler {
	if opt.Metrics == nil {
		opt.Metrics = metrics.New()
	}
	if opt.Log == nil {
		opt.Log = slog.Default()
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.MaxBodyBytes <= 0 {
		opt.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if opt.MaxDecompressed <= 0 {
		opt.MaxDecompressed = DefaultMaxDecompressed
	}
	if opt.MaxJSONItem <= 0 {
		opt.MaxJSONItem = DefaultMaxJSONItem
	}
	if opt.InFlight <= 0 {
		opt.InFlight = DefaultInFlight
	}
	if opt.InFlightWait <= 0 {
		opt.InFlightWait = DefaultInFlightWait
	}
	if opt.BodyFirstByteWait <= 0 {
		opt.BodyFirstByteWait = DefaultBodyFirstByteWait
	}
	if opt.BodyGrace <= 0 {
		opt.BodyGrace = DefaultBodyGrace
	}
	if opt.BodyMinRate <= 0 {
		opt.BodyMinRate = DefaultBodyMinRate
	}
	if opt.BodyMaxWait <= 0 {
		opt.BodyMaxWait = DefaultBodyMaxWait
	}
	if opt.DailyBytes == nil {
		opt.DailyBytes = func(context.Context, string, string) (int64, bool, error) { return 0, false, nil }
	}
	if opt.Fails == nil {
		opt.Fails = addrlimit.NewFailBuckets(opt.Now)
	}
	h := &Handler{opt: opt, mux: http.NewServeMux(), sem: make(chan struct{}, opt.InFlight),
		quota: &quotaTracker{load: opt.DailyBytes, m: map[string]*quotaState{}},
		fails: opt.Fails, perAddr: &addrSlots{m: map[string]int{}},
		refusal: &dropCounter{m: map[dropKey]int64{}}}
	h.mux.HandleFunc("POST /api/{resource}/envelope/{$}", h.envelope)
	h.mux.HandleFunc("POST /api/{resource}/store/{$}", h.envelope)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

// errStatus carries the HTTP status of a refusal out of accept.
type errStatus struct {
	status int
	reason string
	err    error
}

func (e *errStatus) Error() string { return fmt.Sprintf("%d %s: %v", e.status, e.reason, e.err) }

func refuse(status int, reason string, err error) error {
	return &errStatus{status: status, reason: reason, err: err}
}

func (h *Handler) envelope(w http.ResponseWriter, r *http.Request) {
	addr := addrlimit.ClientAddr(r)
	res, status := h.authorize(r, addr)
	if status == http.StatusServiceUnavailable && res.ID == "" {
		// The address spent its failure budget: back off, never "stop" (a 401
		// tells a client its key is wrong, which may not be true behind NAT).
		w.Header().Set("Retry-After", fmt.Sprint(failRetryAfterSeconds))
	}
	if status == http.StatusServiceUnavailable && res.ID != "" {
		h.refused(w, res.ID, status, "console") // resource source unreachable
		return
	}
	if status != 0 {
		h.reject(w, status, 0)
		return
	}
	stats := h.opt.Metrics.Resource(res.ID)
	stats.LastSeenMs.Store(h.opt.Now().UnixMilli())
	if h.opt.DumpDir != "" {
		h.dumpRequest(w, r, res.ID)
		return
	}

	// Envelopes in flight are bounded (each keeps at most
	// MaxKeptBytesPerEnvelope plus one JSON item in memory), and one address
	// may hold at most MaxInFlightPerAddress of them.
	if !h.perAddr.acquire(addr) {
		h.refused(w, res.ID, http.StatusServiceUnavailable, "busy")
		return
	}
	defer h.perAddr.release(addr)
	// Wait for the first body byte before taking a shared slot, so a client
	// that connects and stalls holds only its own address's slots.
	start := time.Now() // wall clock: read deadlines are wall-clock
	rc := http.NewResponseController(w)
	pb := &pacedBody{r: r.Body, c: r.Body}
	first := bufio.NewReader(pb)
	if r.ContentLength != 0 { // an empty body is already read: arming a deadline would only cancel the request later
		_ = rc.SetReadDeadline(start.Add(h.opt.BodyFirstByteWait)) // ErrNotSupported only off a real server
		if _, err := first.Peek(1); err != nil && !errors.Is(err, io.EOF) {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				h.refused(w, res.ID, http.StatusServiceUnavailable, store.ReasonSlow)
			}
			return // otherwise the client went away
		}
	}
	r.Body = struct {
		io.Reader
		io.Closer
	}{first, pb}
	timer := time.NewTimer(h.opt.InFlightWait)
	select {
	case h.sem <- struct{}{}:
		timer.Stop()
	case <-timer.C:
		h.refused(w, res.ID, http.StatusServiceUnavailable, "busy")
		return
	case <-r.Context().Done():
		timer.Stop()
		return
	}
	h.opt.Metrics.Gauges.InFlight.Add(1)
	defer func() {
		<-h.sem
		h.opt.Metrics.Gauges.InFlight.Add(-1)
	}()
	// Holding the slot needs progress: the deadline moves with the bytes read.
	pb.pace(rc, time.Now(), h.opt.BodyGrace, h.opt.BodyMinRate, start.Add(h.opt.BodyMaxWait))

	now := h.opt.Now()
	day := normalize.Day(now.UnixMilli())
	used, err := h.quota.get(r.Context(), res.ID, day)
	if err != nil {
		h.opt.Log.Warn("daily bytes read failed", "resource", res.ID, "err", err)
		h.reject(w, http.StatusServiceUnavailable, 0)
		return
	}
	// Staged degradation: 120 % refuses with a short Retry-After, 100 % drops attachments.
	if res.DailyBytes > 0 && used*100 >= res.DailyBytes*refusedQuotaPercent {
		stats.QuotaHits.Add(1)
		w.Header().Set("Retry-After", fmt.Sprint(QuotaRetryAfterSeconds))
		h.refused(w, res.ID, http.StatusTooManyRequests, store.ReasonQuotaRefused)
		return
	}
	if h.opt.Capacity != nil && !h.opt.Capacity.Allow(0) {
		h.refused(w, res.ID, http.StatusServiceUnavailable, store.ReasonDisk)
		return
	}
	dropAttachments := res.DailyBytes > 0 && used >= res.DailyBytes

	body, err := h.decode(w, r)
	if err != nil {
		h.fail(w, r, res.ID, err)
		return
	}
	legacy := strings.HasSuffix(r.URL.Path, "/store/")
	id, total, err := h.accept(r.Context(), res, body, legacy, dropAttachments, now)
	if err != nil {
		h.fail(w, r, res.ID, err)
		return
	}
	stats.Accepted.Add(1)
	stats.Bytes.Add(total)
	h.opt.Metrics.Counters.EnvelopesAccepted.Add(1)
	h.opt.Metrics.Counters.BytesIngested.Add(total)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// fail answers an accept/decode error with its status, counting it.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, resourceID string, err error) {
	var es *errStatus
	if errors.As(err, &es) {
		h.refused(w, resourceID, es.status, es.reason)
		return
	}
	if r.Context().Err() != nil {
		return // the client went away mid-body
	}
	h.opt.Log.Warn("ingest failed", "resource", resourceID, "err", err)
	h.opt.Metrics.Counters.StoreErrors.Add(1)
	h.refused(w, resourceID, http.StatusServiceUnavailable, "store_error")
}

// refused answers a refusal of a whole envelope and counts it in drops. The
// count is kept in memory and flushed by Run, so a flood of refusals never
// becomes a flood of transactions.
func (h *Handler) refused(w http.ResponseWriter, resourceID string, status int, reason string) {
	if reason == store.ReasonSlow {
		w.Header().Set("Retry-After", fmt.Sprint(slowRetryAfterSeconds))
	}
	if reason != "console" { // a `console` id was never confirmed: no per-resource bucket for it
		h.opt.Metrics.Resource(resourceID).Refused.Add(1)
	}
	nowMs := h.opt.Now().UnixMilli()
	h.refusal.add(dropKey{resource: resourceID, day: normalize.Day(nowMs), itemType: envelopeItemForRefusals, reason: reason}, nowMs, reason == store.ReasonQuotaRefused)
	h.reject(w, status, 0)
}

// Run flushes refusal counters every few seconds until ctx ends, then once more.
func (h *Handler) Run(ctx context.Context) {
	t := time.NewTicker(dropFlushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			h.FlushDrops(fctx)
			cancel()
			return
		case <-t.C:
			h.FlushDrops(ctx)
		}
	}
}

// FlushDrops writes the pending refusal counters.
func (h *Handler) FlushDrops(ctx context.Context) {
	if h.opt.Writer == nil {
		return
	}
	for k, v := range h.refusal.take() {
		b := &store.Batch{ResourceID: k.resource, Day: k.day, Drops: []store.Drop{{ItemType: k.itemType, Reason: k.reason, Count: v.count}}, QuotaHitMs: v.quotaHitMs}
		if _, err := h.opt.Writer.Write(ctx, b); err != nil {
			h.opt.Metrics.Counters.StoreErrors.Add(1)
			h.opt.Log.Warn("drop count flush failed", "resource", k.resource, "err", err)
		}
	}
}

type dropKey struct{ resource, day, itemType, reason string }

type dropVal struct {
	count      int64
	quotaHitMs int64
}

// maxDropKeys bounds the refusals held between flushes: a `console` refusal
// names an id the console could not confirm, so its keys are not all real.
const maxDropKeys = 1024

// dropCounter aggregates whole-envelope refusals between flushes. Keys are
// resource ids × a fixed reason set, bounded by maxDropKeys.
type dropCounter struct {
	mu  sync.Mutex
	m   map[dropKey]int64
	hit map[dropKey]int64
}

func (d *dropCounter) add(k dropKey, nowMs int64, quotaHit bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.m[k]; !ok && len(d.m) >= maxDropKeys {
		return // the refusal is still in the metrics counters
	}
	d.m[k]++
	if quotaHit {
		if d.hit == nil {
			d.hit = map[dropKey]int64{}
		}
		if _, ok := d.hit[k]; !ok {
			d.hit[k] = nowMs
		}
	}
}

func (d *dropCounter) take() map[dropKey]dropVal {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[dropKey]dropVal, len(d.m))
	for k, v := range d.m {
		out[k] = dropVal{count: v, quotaHitMs: d.hit[k]}
	}
	d.m, d.hit = map[dropKey]int64{}, nil
	return out
}

// addrSlots counts envelopes in flight per address.
type addrSlots struct {
	mu sync.Mutex
	m  map[string]int
}

func (a *addrSlots) acquire(addr string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m[addr] >= MaxInFlightPerAddress {
		return false
	}
	a.m[addr]++
	return true
}

func (a *addrSlots) release(addr string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m[addr]--; a.m[addr] <= 0 {
		delete(a.m, addr)
	}
}

// decode applies the compressed cap and the Content-Encoding.
func (h *Handler) decode(w http.ResponseWriter, r *http.Request) (io.Reader, error) {
	body := http.MaxBytesReader(w, r.Body, h.opt.MaxBodyBytes)
	var dec io.Reader
	switch enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
		dec = body
	case "gzip", "x-gzip":
		gz, err := gzip.NewReader(body)
		if err != nil {
			return nil, h.readErr(err)
		}
		dec = gz
	case "deflate":
		// HTTP "deflate" is zlib-wrapped; some clients send raw deflate.
		br := bufio.NewReader(body)
		if b, err := br.Peek(2); err == nil && b[0]&0x0f == 8 && (uint16(b[0])<<8|uint16(b[1]))%31 == 0 {
			zr, err := zlib.NewReader(br)
			if err != nil {
				return nil, h.readErr(err)
			}
			dec = zr
		} else {
			dec = flate.NewReader(br)
		}
	default:
		return nil, refuse(http.StatusUnsupportedMediaType, store.ReasonInvalid, fmt.Errorf("content-encoding %q", enc))
	}
	return &capReader{r: dec, left: h.opt.MaxDecompressed}, nil
}

var errDecompressedTooLarge = errors.New("ingest: decompressed body over the cap")

// capReader fails once more than left bytes were read.
type capReader struct {
	r    io.Reader
	left int64
	read int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left < 0 {
		return 0, errDecompressedTooLarge
	}
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	c.read += int64(n)
	if c.left < 0 {
		return n, errDecompressedTooLarge
	}
	return n, err
}

// readErr maps a body read error to a refusal.
func (h *Handler) readErr(err error) error {
	var mbe *http.MaxBytesError
	switch {
	case errors.Is(err, os.ErrDeadlineExceeded):
		return refuse(http.StatusServiceUnavailable, store.ReasonSlow, err)
	case errors.As(err, &mbe), errors.Is(err, errDecompressedTooLarge):
		return refuse(http.StatusRequestEntityTooLarge, store.ReasonTooLarge, err)
	case errors.Is(err, envelope.ErrMalformed), errors.Is(err, envelope.ErrTruncated),
		errors.Is(err, envelope.ErrHeaderTooLong), errors.Is(err, envelope.ErrItemTooLarge),
		errors.Is(err, gzip.ErrHeader), errors.Is(err, gzip.ErrChecksum), errors.Is(err, zlib.ErrHeader),
		errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return refuse(http.StatusBadRequest, store.ReasonInvalid, err)
	}
	var ce flate.CorruptInputError
	if errors.As(err, &ce) {
		return refuse(http.StatusBadRequest, store.ReasonInvalid, err)
	}
	return err
}

// Accept stores one decompressed envelope for res outside HTTP (`tracer dev
// seed`); quota and capacity are not applied.
func (h *Handler) Accept(ctx context.Context, res resource.Resource, body io.Reader, now time.Time) (string, error) {
	id, _, err := h.accept(ctx, res, &capReader{r: body, left: h.opt.MaxDecompressed}, false, false, now)
	return id, err
}

// accept streams the items of one envelope into a batch and commits it.
// total is what the envelope adds to the quota and the stage: stored payload
// bytes plus RowOverhead per stored row (dropped bytes go to drops.bytes only).
func (h *Handler) accept(ctx context.Context, res resource.Resource, body io.Reader, legacy, dropAttachments bool, now time.Time) (id string, total int64, err error) {
	nowMs := now.UnixMilli()
	b := &store.Batch{ResourceID: res.ID, Day: normalize.Day(nowMs), ReceivedMs: nowMs}
	var blobs []string
	defer func() {
		if err != nil {
			for _, p := range blobs {
				os.Remove(p)
			}
		}
	}()
	drops := map[[2]string]*store.Drop{}
	drop := func(typ, reason string, count, n int64) {
		if count <= 0 {
			return
		}
		k := [2]string{typ, reason}
		if drops[k] == nil {
			drops[k] = &store.Drop{ItemType: typ, Reason: reason}
		}
		drops[k].Count += count
		drops[k].Bytes += n
		h.opt.Metrics.Counters.ItemsDropped.Add(count)
		h.opt.Metrics.Resource(res.ID).Dropped.Add(count)
	}
	var kept int64 // JSON payload bytes held in b
	var items, eventItems int
	keep := func(typ string, p []byte, n int64, headerEventID string) {
		if kept+n > MaxKeptBytesPerEnvelope {
			drop(typ, store.ReasonTooLarge, 1, n)
			return
		}
		before := len(b.Events) + len(b.Logs) + len(b.Transactions) + len(b.Sessions)
		logsDropped, ok := h.addItem(b, typ, p, headerEventID, nowMs)
		if !ok {
			drop(typ, store.ReasonInvalid, 1, n)
			return
		}
		drop(typ, store.ReasonTooLarge, int64(logsDropped), 0)
		kept += n
		rows := len(b.Events) + len(b.Logs) + len(b.Transactions) + len(b.Sessions) - before
		total += n + int64(rows)*RowOverhead
	}

	var headerEventID string
	if legacy {
		// `/store/`: the body is one event JSON.
		p, n, rerr := readItem(body, h.opt.MaxJSONItem)
		if rerr != nil {
			return "", total, h.readErr(rerr)
		}
		if p == nil {
			drop("event", store.ReasonTooLarge, 1, n)
		} else {
			keep("event", p, n, "")
		}
	} else {
		er, rerr := envelope.NewReader(body, h.opt.MaxJSONItem)
		if rerr != nil {
			return "", 0, h.readErr(rerr)
		}
		headerEventID = normalize.EventID(er.Header().EventID)
		for {
			ih, pr, nerr := er.Next()
			if errors.Is(nerr, io.EOF) {
				break
			}
			typ := ih.Type
			if !knownType(typ) {
				typ = unknownItemType
			}
			if errors.Is(nerr, envelope.ErrItemTooLarge) {
				drop(typ, store.ReasonTooLarge, 1, er.Skipped())
				continue
			}
			if nerr != nil {
				return "", total, h.readErr(nerr)
			}
			items++
			overCount := items > MaxItemsPerEnvelope
			switch typ {
			case envelope.TypeEvent, envelope.TypeFeedback, envelope.TypeTransaction:
				eventItems++
				overCount = overCount || eventItems > MaxEventItemsPerEnvelope
			case envelope.TypeAttachment:
				overCount = overCount || len(b.Attachments) >= MaxAttachmentsPerEnvelope
			case envelope.TypeSession:
				overCount = overCount || len(b.Sessions) >= MaxSessionsPerEnvelope
			case envelope.TypeLog:
				overCount = overCount || len(b.Logs) >= MaxLogRowsPerEnvelope
			}
			if overCount {
				n, cerr := io.Copy(io.Discard, pr)
				if cerr != nil {
					return "", total, h.readErr(cerr)
				}
				drop(typ, store.ReasonTooLarge, 1, n)
				continue
			}
			switch {
			case typ == envelope.TypeAttachment:
				if dropAttachments {
					n, cerr := io.Copy(io.Discard, pr)
					if cerr != nil {
						return "", total, h.readErr(cerr)
					}
					drop(typ, store.ReasonQuotaAttachment, 1, n)
					continue
				}
				a, n, aerr := h.writeBlob(res.ID, now, ih, pr)
				if aerr != nil {
					return "", total, aerr
				}
				blobs = append(blobs, a.AbsPath)
				a.EventID = headerEventID
				b.Attachments = append(b.Attachments, a)
				total += n + RowOverhead
			case typ == envelope.TypeEvent || typ == envelope.TypeFeedback || typ == envelope.TypeTransaction ||
				typ == envelope.TypeLog || typ == envelope.TypeSession:
				p, n, rerr := readItem(pr, h.opt.MaxJSONItem)
				if rerr != nil {
					return "", total, h.readErr(rerr)
				}
				if p == nil {
					drop(typ, store.ReasonTooLarge, 1, n)
					continue
				}
				keep(typ, p, n, headerEventID)
			default:
				n, cerr := io.Copy(io.Discard, pr)
				if cerr != nil {
					return "", total, h.readErr(cerr)
				}
				reason := store.ReasonUnknown
				if envelope.NotStored(typ) {
					reason = store.ReasonNotStored
				}
				drop(typ, reason, 1, n)
			}
		}
	}
	if len(b.Logs) > MaxLogRowsPerEnvelope {
		drop(envelope.TypeLog, store.ReasonTooLarge, int64(len(b.Logs)-MaxLogRowsPerEnvelope), 0)
		b.Logs = b.Logs[:MaxLogRowsPerEnvelope]
	}
	for _, d := range drops {
		b.Drops = append(b.Drops, *d)
	}
	if h.opt.Capacity != nil && !h.opt.Capacity.Allow(total) {
		return "", total, refuse(http.StatusServiceUnavailable, store.ReasonDisk, errors.New("stage cap or volume line"))
	}
	b.Bytes, b.AttachmentOverhead = total, RowOverhead
	crossed := h.quota.crosses(res.ID, b.Day, total, res.DailyBytes)
	if crossed {
		b.QuotaHitMs = nowMs
	}
	result, werr := h.opt.Writer.Write(ctx, b)
	if werr != nil {
		return "", total, werr
	}
	total -= result.DuplicateBytes
	h.quota.add(res.ID, b.Day, total, crossed)
	if h.opt.Capacity != nil {
		h.opt.Capacity.Add(total)
	}
	if d := drops[[2]string{envelope.TypeAttachment, store.ReasonQuotaAttachment}]; d != nil {
		h.opt.Metrics.Resource(res.ID).QuotaHits.Add(1)
	}
	stored := len(b.Events) + len(b.Logs) + len(b.Transactions) + len(b.Sessions) + len(b.Attachments) - result.DuplicateRows
	h.opt.Metrics.Counters.ItemsStored.Add(int64(stored))
	h.opt.Metrics.Counters.Duplicates.Add(int64(result.DuplicateRows))

	id = headerEventID
	if id == "" && len(b.Events) > 0 {
		id = b.Events[0].EventID
	}
	if id == "" && len(b.Transactions) > 0 {
		id = b.Transactions[0].EventID
	}
	return id, total, nil
}

func knownType(t string) bool {
	switch t {
	case envelope.TypeEvent, envelope.TypeFeedback, envelope.TypeTransaction, envelope.TypeLog,
		envelope.TypeAttachment, envelope.TypeSession:
		return true
	}
	return envelope.NotStored(t)
}

// addItem normalizes one JSON item into b; for a log container it also
// reports entries normalize discarded (over its per-item cap or unparsable).
func (h *Handler) addItem(b *store.Batch, typ string, p []byte, headerEventID string, nowMs int64) (logsDropped int, ok bool) {
	switch typ {
	case envelope.TypeEvent, envelope.TypeFeedback:
		e, err := normalize.Event(p, typ, headerEventID, nowMs)
		if err != nil {
			return 0, false
		}
		b.Events = append(b.Events, e)
	case envelope.TypeTransaction:
		t, err := normalize.Transaction(p, headerEventID, nowMs)
		if err != nil {
			return 0, false
		}
		b.Transactions = append(b.Transactions, t)
	case envelope.TypeLog:
		logs, dropped, err := normalize.Logs(p, nowMs)
		if err != nil {
			return 0, false
		}
		b.Logs = append(b.Logs, logs...)
		return dropped, true
	case envelope.TypeSession:
		s, err := normalize.Session(p, nowMs)
		if err != nil {
			return 0, false
		}
		b.Sessions = append(b.Sessions, s)
	}
	return 0, true
}

// readItem reads a JSON item up to max bytes; over the cap it drains the rest
// and returns a nil payload with the total size.
func readItem(r io.Reader, max int64) ([]byte, int64, error) {
	p, err := io.ReadAll(io.LimitReader(r, max+1))
	n := int64(len(p))
	if err != nil {
		return nil, n, err
	}
	if n <= max {
		return p, n, nil
	}
	rest, err := io.Copy(io.Discard, r)
	return nil, n + rest, err
}

// writeBlob streams an attachment to blobs/{trc}/{day}/{blobId}: a temp file
// in the same directory, sha256 while copying, fsync, then rename.
func (h *Handler) writeBlob(resourceID string, now time.Time, ih envelope.ItemHeader, pr io.Reader) (store.Attachment, int64, error) {
	if h.opt.Capacity != nil && ih.Length != nil && !h.opt.Capacity.Allow(*ih.Length) {
		n, _ := io.Copy(io.Discard, pr)
		return store.Attachment{}, n, refuse(http.StatusServiceUnavailable, store.ReasonDisk, errors.New("attachment over capacity"))
	}
	var rb [16]byte
	if _, err := rand.Read(rb[:]); err != nil {
		return store.Attachment{}, 0, err
	}
	blobID := hex.EncodeToString(rb[:])
	rel := filepath.Join(resourceID, now.UTC().Format("2006-01-02"), blobID)
	abs := filepath.Join(h.opt.BlobDir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return store.Attachment{}, 0, err
	}
	tmp := filepath.Join(filepath.Dir(abs), ".tmp-"+blobID)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return store.Attachment{}, 0, err
	}
	sum := sha256.New()
	n, cerr := io.Copy(io.MultiWriter(f, sum), pr)
	if cerr == nil {
		cerr = f.Sync()
	}
	if err := f.Close(); cerr == nil {
		cerr = err
	}
	if cerr == nil {
		cerr = os.Rename(tmp, abs)
	}
	if cerr == nil {
		cerr = syncDir(filepath.Dir(abs)) // the rename survives a crash before the row commits
	}
	if cerr != nil {
		os.Remove(tmp)
		if rerr := h.readErr(cerr); rerr != cerr {
			return store.Attachment{}, n, rerr
		}
		return store.Attachment{}, n, cerr
	}
	return store.Attachment{
		BlobID: blobID, Path: rel, AbsPath: abs, Filename: clipText(filepath.Base(ih.Filename), 200),
		ContentType: clipText(ih.ContentType, 100), AttachmentType: clipText(ih.AttachmentType, 64),
		Size: n, SHA256: hex.EncodeToString(sum.Sum(nil)),
	}, n, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// SweepTemp removes `.tmp-*` blob files a crash left behind (start-up).
func SweepTemp(blobDir string) (int, error) {
	n := 0
	err := filepath.WalkDir(blobDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !d.IsDir() && strings.HasPrefix(d.Name(), ".tmp-") {
			if os.Remove(p) == nil {
				n++
			}
		}
		return nil
	})
	return n, err
}

func clipText(s string, n int) string {
	if s == "." || s == "/" {
		return ""
	}
	if len(s) > n {
		return s[:n]
	}
	return s
}

// authorize resolves the resource and checks the write key. An unknown or
// inactive resource and a wrong key answer the same 401, so ids cannot be
// probed. An address that keeps failing is refused before the lookup (no
// console call per guess). A source failure (console unreachable) is a 503.
func (h *Handler) authorize(r *http.Request, addr string) (resource.Resource, int) {
	id := r.PathValue("resource")
	if !config.ResourceIDPattern.MatchString(id) {
		h.fails.Fail(addr)
		return resource.Resource{}, http.StatusUnauthorized
	}
	if !h.fails.Allowed(addr) {
		return resource.Resource{}, http.StatusServiceUnavailable
	}
	key := SentryKey(r)
	res, err := h.opt.Source.Lookup(r.Context(), id)
	switch {
	case errors.Is(err, resource.ErrNotFound):
		h.fails.Fail(addr)
		return res, http.StatusUnauthorized
	case err != nil:
		// No answer for an id it had never seen (a known one rides its stale
		// config): spend the address's budget, so made-up ids during a console
		// outage do not become one console call each.
		h.fails.Fail(addr)
		h.opt.Log.Warn("resource lookup failed", "resource", id, "err", err)
		return resource.Resource{ID: id}, http.StatusServiceUnavailable
	}
	if !res.KeyMatches(key) || !res.Active() {
		h.fails.Fail(addr)
		return res, http.StatusUnauthorized
	}
	return res, 0
}

func (h *Handler) reject(w http.ResponseWriter, status int, _ int64) {
	h.opt.Metrics.Counters.CountRejection(status)
	detail := map[int]string{
		http.StatusBadRequest:            "malformed envelope",
		http.StatusUnauthorized:          "invalid resource or sentry_key",
		http.StatusRequestEntityTooLarge: "envelope too large",
		http.StatusUnsupportedMediaType:  "unsupported content-encoding",
		http.StatusTooManyRequests:       "daily quota reached",
		http.StatusServiceUnavailable:    "temporarily unavailable",
	}[status]
	writeJSON(w, status, map[string]string{"detail": detail})
}

// quotaTracker caches today's byte counter per resource.
type quotaTracker struct {
	mu   sync.Mutex
	load func(ctx context.Context, resource, day string) (int64, bool, error)
	m    map[string]*quotaState
}

type quotaState struct {
	day   string
	bytes int64
	hit   bool
}

func (q *quotaTracker) get(ctx context.Context, res, day string) (int64, error) {
	q.mu.Lock()
	s, ok := q.m[res]
	q.mu.Unlock()
	if ok && s.day == day {
		return s.bytes, nil
	}
	n, hit, err := q.load(ctx, res, day)
	if err != nil {
		return 0, err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if cur, ok := q.m[res]; ok && cur.day == day {
		return cur.bytes, nil
	}
	q.m[res] = &quotaState{day: day, bytes: n, hit: hit}
	return n, nil
}

// crosses reports whether n more bytes make the day's first quota crossing.
func (q *quotaTracker) crosses(res, day string, n, limit int64) bool {
	if limit <= 0 {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	s, ok := q.m[res]
	return ok && s.day == day && !s.hit && s.bytes+n >= limit
}

// add records committed bytes (and the crossing, once it is committed).
func (q *quotaTracker) add(res, day string, n int64, crossed bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	s, ok := q.m[res]
	if !ok || s.day != day {
		s = &quotaState{day: day}
		q.m[res] = s
	}
	s.bytes += n
	s.hit = s.hit || crossed
}

// dumpRequest writes the raw body and the request line + headers
// (credentials removed) for fixture capture (todo/85 P2). Files are 0600 and
// must be scrubbed before anything reaches testdata.
func (h *Handler) dumpRequest(w http.ResponseWriter, r *http.Request, resourceID string) {
	if err := h.dump(r, resourceID); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			h.reject(w, http.StatusRequestEntityTooLarge, 0)
			return
		}
		h.opt.Log.Warn("dump failed", "resource", resourceID, "err", err)
		h.reject(w, http.StatusServiceUnavailable, 0)
		return
	}
	h.opt.Metrics.Counters.EnvelopesAccepted.Add(1)
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (h *Handler) dump(r *http.Request, resourceID string) error {
	if err := os.MkdirAll(h.opt.DumpDir, 0o700); err != nil {
		return err
	}
	n := h.dumps.Add(1)
	base := filepath.Join(h.opt.DumpDir, fmt.Sprintf("%d-%04d-%s", h.opt.Now().UTC().UnixMilli(), n, resourceID))
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, h.opt.MaxBodyBytes))
	if err != nil {
		return err
	}
	if err := os.WriteFile(base+".body", body, 0o600); err != nil {
		return err
	}
	meta := map[string]any{
		"method":  r.Method,
		"path":    r.URL.Path,
		"query":   ScrubQuery(r.URL.Query()),
		"headers": ScrubHeaders(r.Header),
		"bytes":   len(body),
	}
	b, _ := json.MarshalIndent(meta, "", "  ")
	return os.WriteFile(base+".meta.json", b, 0o600)
}

// credentialHeaders never leave the process.
var credentialHeaders = map[string]bool{"X-Sentry-Auth": true, "Authorization": true, "Proxy-Authorization": true, "Cookie": true}

// ScrubHeaders copies headers without credentials; the X-Sentry-Auth value is
// kept with its sentry_key replaced, since the client name and version in it
// are what a capture is for.
func ScrubHeaders(hd http.Header) map[string]string {
	out := map[string]string{}
	for k, v := range hd {
		if credentialHeaders[k] {
			if k == "X-Sentry-Auth" && len(v) > 0 {
				out[k] = scrubAuth(v[0])
			}
			continue
		}
		out[k] = strings.Join(v, ", ")
	}
	return out
}

func scrubAuth(v string) string {
	parts := authParts(v)
	out := make([]string, len(parts))
	for i, p := range parts {
		switch {
		case isCredentialParam(p.name):
			out[i] = p.name + "=<redacted>"
		case p.hasValue:
			out[i] = p.name + "=" + p.value
		default:
			out[i] = p.name
		}
	}
	return "Sentry " + strings.Join(out, ", ")
}

type authParam struct {
	name, value string
	hasValue    bool
}

// authParts splits an X-Sentry-Auth value after its scheme (any case, any
// whitespace) into trimmed name=value pairs. SentryKey and scrubAuth share it,
// so whatever authenticates is also what gets redacted.
func authParts(v string) []authParam {
	v = strings.TrimSpace(v)
	if len(v) >= 6 && strings.EqualFold(v[:6], "sentry") && (len(v) == 6 || v[6] == ' ' || v[6] == '\t') {
		v = v[6:]
	}
	var out []authParam
	for _, part := range strings.Split(v, ",") {
		k, val, ok := strings.Cut(strings.TrimSpace(part), "=")
		out = append(out, authParam{name: strings.TrimSpace(k), value: strings.TrimSpace(val), hasValue: ok})
	}
	return out
}

func isCredentialParam(name string) bool {
	return strings.EqualFold(name, "sentry_key") || strings.EqualFold(name, "sentry_secret")
}

// ScrubQuery copies the query without sentry_key/sentry_secret.
func ScrubQuery(q map[string][]string) map[string]string {
	out := map[string]string{}
	for k, v := range q {
		if isCredentialParam(k) {
			out[k] = "<redacted>"
			continue
		}
		out[k] = strings.Join(v, ",")
	}
	return out
}

// SentryKey extracts sentry_key from X-Sentry-Auth
// ("Sentry sentry_key=<key>, sentry_version=7, ...") or the query string.
func SentryKey(r *http.Request) string {
	if auth := r.Header.Get("X-Sentry-Auth"); auth != "" {
		for _, p := range authParts(auth) {
			if p.hasValue && p.name == "sentry_key" {
				return p.value
			}
		}
	}
	return r.URL.Query().Get("sentry_key")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// pacedBody is a request body whose read deadline, once paced, is
// start + grace + bytesRead/minRate, capped at limit: a client that keeps
// sending at minRate on average keeps its slot, a stalled one loses it.
// After the body's EOF it never touches the deadline again: net/http clears
// it and starts its background read then, and a re-armed deadline would
// cancel the request context while the envelope is still being stored.
type pacedBody struct {
	r     io.Reader
	c     io.Closer
	rc    *http.ResponseController
	start time.Time
	grace time.Duration
	rate  int64
	limit time.Time
	read  int64
	eof   bool
}

func (p *pacedBody) pace(rc *http.ResponseController, start time.Time, grace time.Duration, rate int64, limit time.Time) {
	p.rc, p.start, p.grace, p.rate, p.limit = rc, start, grace, rate, limit
	p.extend()
}

func (p *pacedBody) extend() {
	if p.eof || p.rc == nil {
		return
	}
	d := p.start.Add(p.grace + time.Duration(p.read)*time.Second/time.Duration(p.rate))
	if d.After(p.limit) {
		d = p.limit
	}
	_ = p.rc.SetReadDeadline(d)
}

func (p *pacedBody) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.read += int64(n)
	if err != nil {
		p.eof = true // EOF or a failed read: leave the deadline to net/http
		return n, err
	}
	if n > 0 {
		p.extend()
	}
	return n, err
}

func (p *pacedBody) Close() error { return p.c.Close() }

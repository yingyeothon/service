// Package query is the read API (`GET /v1/{trc}/…`, docs/tracer.md _Read
// API and CLI_): bounded, read-only queries over a `query_only` connection,
// on a mux separate from ingest, consumed by `yyt tracer` and the
// tracer-debug skill. Field names are one contract with both: a rename
// changes all three in one commit (rules/architecture.md).
package query

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yingyeothon/service/tracer/internal/addrlimit"
	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/normalize"
	"github.com/yingyeothon/service/tracer/internal/resource"
)

// Bounds (docs/tracer.md: bounded by default, long strings truncated).
const (
	DefaultLimit    = 50
	MaxLimit        = 500
	MaxString       = 2000
	DefaultWindow   = 2 * time.Minute
	MaxWindow       = 30 * time.Minute
	MaxDays         = 31
	DefaultDays     = 7
	DefaultSince    = 24 * time.Hour
	MaxLookback     = 31 * 24 * time.Hour // retention is 30 days; older bounds are clamped
	TagValuesLimit  = 20
	TagKeysLimit    = 100
	MaxTimelineSide = 500 // per source, on each side of the anchor
	MaxRawJSON      = 16 << 10
	QueryTimeout    = 5 * time.Second
)

var attrKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.\-]{1,64}$`)

// ErrUnauthenticated: no, malformed, unknown or revoked token (401).
var ErrUnauthenticated = errors.New("query: unauthenticated")

// ErrForbidden: every other refusal (404, never 403).
var ErrForbidden = errors.New("query: not visible")

// ErrUnavailable: the authorizer could not answer (console unreachable) —
// a 503, never a refusal. Any other error maps to it as well.
var ErrUnavailable = errors.New("query: authorization unavailable")

// failRetryAfterSeconds is the back-off an address over its failure budget gets.
const failRetryAfterSeconds = 60

// Authorizer answers whether a `yyt_` token may read a resource. Server mode
// asks the console (`POST /tr/authz`, P5); local mode compares the static token.
type Authorizer interface {
	Authorize(ctx context.Context, token, resourceID string) error
}

// LocalAuthorizer accepts the static `readToken` of `tracer.json` for the
// resources of that file. An empty token refuses everything.
type LocalAuthorizer struct {
	tokenSum [32]byte
	has      bool
	src      resource.Source
}

// NewLocalAuthorizer builds a LocalAuthorizer.
func NewLocalAuthorizer(token string, src resource.Source) *LocalAuthorizer {
	a := &LocalAuthorizer{src: src}
	if token != "" {
		a.tokenSum, a.has = sha256.Sum256([]byte(token)), true
	}
	return a
}

// Authorize implements Authorizer.
func (a *LocalAuthorizer) Authorize(ctx context.Context, token, resourceID string) error {
	sum := sha256.Sum256([]byte(token))
	if !a.has || subtle.ConstantTimeCompare(sum[:], a.tokenSum[:]) != 1 {
		return ErrUnauthenticated
	}
	if _, err := a.src.Lookup(ctx, resourceID); err != nil {
		return ErrForbidden
	}
	return nil
}

// Options configures a Handler.
type Options struct {
	DB      *sql.DB // read-only (store.OpenReadOnly)
	BlobDir string
	Auth    Authorizer
	Metrics *metrics.Registry
	Log     *slog.Logger
	Now     func() time.Time
	// Fails limits failed authentications per client address (default: own set).
	Fails *addrlimit.FailBuckets
}

// Handler serves `/v1/…`.
type Handler struct {
	opt Options
	mux *http.ServeMux
}

// New builds the read handler.
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
	if opt.Fails == nil {
		opt.Fails = addrlimit.NewFailBuckets(opt.Now)
	}
	h := &Handler{opt: opt, mux: http.NewServeMux()}
	h.route("GET /v1/{trc}/issues", h.issues)
	h.route("GET /v1/{trc}/issues/{group}/tags", h.issueTags)
	h.route("GET /v1/{trc}/events", h.events)
	h.route("GET /v1/{trc}/events/{id}", h.event)
	h.route("GET /v1/{trc}/events/{id}/timeline", h.timeline)
	h.route("GET /v1/{trc}/logs", h.logs)
	h.route("GET /v1/{trc}/attachments/{id}", h.attachment)
	h.route("GET /v1/{trc}/drops", h.drops)
	h.route("GET /v1/{trc}/usage", h.usage)
	h.mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

type ctxKey struct{}

// route wraps a handler with authentication and authorization: token shape
// first (a write key or anything else is a 401 without an authz call), then
// the Authorizer; 401 unknown token, 404 everything else.
func (h *Handler) route(pattern string, fn func(http.ResponseWriter, *http.Request, string)) {
	h.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		h.opt.Metrics.Counters.ReadRequests.Add(1)
		addr := addrlimit.ClientAddr(r)
		// An address that keeps failing is refused before any authz call,
		// so guessed tokens never become one console call each.
		if !h.opt.Fails.Allowed(addr) {
			h.opt.Metrics.Counters.ReadRejected.Add(1)
			w.Header().Set("Retry-After", strconv.Itoa(failRetryAfterSeconds))
			writeError(w, http.StatusServiceUnavailable, "unavailable", "too many failed attempts from this address; retry later")
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !config.ServerReadTokenPattern.MatchString(token) {
			h.opt.Fails.Fail(addr)
			h.opt.Metrics.Counters.ReadRejected.Add(1)
			writeError(w, http.StatusUnauthorized, "unauthorized", "Authorization: Bearer yyt_… or trr_… is required")
			return
		}
		if strings.HasPrefix(token, config.ReadTicketPrefix) {
			h.opt.Metrics.Counters.ReadTicketRequests.Add(1)
		} else {
			h.opt.Metrics.Counters.ReadTokenRequests.Add(1)
		}
		trc := r.PathValue("trc")
		if !config.ResourceIDPattern.MatchString(trc) {
			h.opt.Metrics.Counters.ReadRejected.Add(1)
			writeError(w, http.StatusNotFound, "not_found", "tracer resource not found")
			return
		}
		switch err := h.opt.Auth.Authorize(r.Context(), token, trc); {
		case err == nil:
		case errors.Is(err, ErrUnauthenticated):
			h.opt.Fails.Fail(addr)
			h.opt.Metrics.Counters.ReadRejected.Add(1)
			writeError(w, http.StatusUnauthorized, "unauthorized", "token unknown or revoked")
			return
		case errors.Is(err, ErrForbidden):
			h.opt.Fails.Fail(addr)
			h.opt.Metrics.Counters.ReadRejected.Add(1)
			writeError(w, http.StatusNotFound, "not_found", "tracer resource not found")
			return
		default:
			h.opt.Log.Warn("read authz failed", "resource", trc, "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable", "authorization is unavailable; retry shortly")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), QueryTimeout)
		defer cancel()
		fn(w, r.WithContext(ctx), trc)
	})
}

// ---- parameters ----

type params struct {
	q   map[string][]string
	err error
	now time.Time
}

func (h *Handler) params(r *http.Request) *params {
	return &params{q: r.URL.Query(), now: h.opt.Now()}
}

func (p *params) str(name string, max int) string {
	if len(p.q[name]) > 1 && p.err == nil {
		p.err = badParam(name, "given once")
	}
	v := strings.TrimSpace(firstOf(p.q[name]))
	if len(v) > max && p.err == nil {
		p.err = badParam(name, "too long")
	}
	return v
}

func (p *params) limit() int {
	v := firstOf(p.q["limit"])
	if v == "" {
		return DefaultLimit
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > MaxLimit {
		if p.err == nil {
			p.err = badParam("limit", "an integer in 1..500")
		}
		return DefaultLimit
	}
	return n
}

// timeParam takes RFC 3339 or a duration back from now ("15m", "2h", "7d").
func (p *params) timeParam(name string, def time.Time) time.Time {
	v := strings.TrimSpace(firstOf(p.q[name]))
	if v == "" {
		return def
	}
	floor := p.now.Add(-MaxLookback)
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		if t.Before(floor) {
			return floor
		}
		return t
	}
	if d, err := parseAgo(v); err == nil && d >= 0 {
		if d > MaxLookback {
			d = MaxLookback
		}
		return p.now.Add(-d)
	}
	if p.err == nil {
		p.err = badParam(name, "RFC 3339 time or a duration like 15m, 2h, 7d")
	}
	return def
}

func (p *params) duration(name string, def, max time.Duration) time.Duration {
	v := strings.TrimSpace(firstOf(p.q[name]))
	if v == "" {
		return def
	}
	d, err := parseAgo(v)
	if err != nil || d <= 0 || d > max {
		if p.err == nil {
			p.err = badParam(name, "a duration up to "+max.String())
		}
		return def
	}
	return d
}

func (p *params) days() int {
	v := firstOf(p.q["days"])
	if v == "" {
		return DefaultDays
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > MaxDays {
		if p.err == nil {
			p.err = badParam("days", "an integer in 1..31")
		}
		return DefaultDays
	}
	return n
}

// pair parses "key:value" (tag/attribute filters).
func (p *params) pair(name string) (string, string, bool) {
	v := p.str(name, 400)
	if v == "" {
		return "", "", false
	}
	k, val, ok := strings.Cut(v, ":")
	if !ok || !attrKeyPattern.MatchString(k) {
		if p.err == nil {
			p.err = badParam(name, "key:value with a key of letters, digits, '.', '_' or '-'")
		}
		return "", "", false
	}
	return k, val, true
}

// cursor reads `cursor=<receivedMs>:<id>` (the `next` of a previous page).
func (p *params) cursor() (int64, int64, bool) {
	v := p.str("cursor", 64)
	if v == "" {
		return 0, 0, false
	}
	a, b, ok := strings.Cut(v, ":")
	ms, err1 := strconv.ParseInt(a, 10, 64)
	id, err2 := strconv.ParseInt(b, 10, 64)
	if !ok || err1 != nil || err2 != nil {
		if p.err == nil {
			p.err = badParam("cursor", "the next value of a previous page")
		}
		return 0, 0, false
	}
	return ms, id, true
}

func nextCursor(ms, id int64) string {
	return strconv.FormatInt(ms, 10) + ":" + strconv.FormatInt(id, 10)
}

func parseAgo(v string) (time.Duration, error) {
	if n, ok := strings.CutSuffix(v, "d"); ok {
		d, err := strconv.Atoi(n)
		if err != nil || d < 0 || d > 3650 {
			return 0, errors.New("bad days")
		}
		return time.Duration(d) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, errors.New("bad duration")
	}
	return d, nil
}

// span validates since < until.
func (p *params) span(since, until time.Time) {
	if p.err == nil && !since.Before(until) {
		p.err = badParam("since", "earlier than until")
	}
}

type paramError struct{ name, want string }

func (e *paramError) Error() string { return "invalid " + e.name + ": " + e.want }

func badParam(name, want string) error { return &paramError{name, want} }

func firstOf(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// ---- output helpers ----

func rfc(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func rfcNull(v sql.NullInt64) *string {
	if !v.Valid {
		return nil
	}
	s := rfc(v.Int64)
	return &s
}

// clip bounds a string for list output and reports whether it was cut.
func clip(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError uses the console envelope so the CLI's exit codes hold.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func (h *Handler) fail(w http.ResponseWriter, err error) {
	var pe *paramError
	switch {
	case errors.As(err, &pe):
		writeError(w, http.StatusBadRequest, "bad_request", pe.Error())
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, context.Canceled):
	default:
		h.opt.Log.Warn("read failed", "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "read failed; retry shortly")
	}
}

// ---- issues ----

// Issue is one group.
type Issue struct {
	GroupKey      string `json:"groupKey"`
	Title         string `json:"title"`
	Level         string `json:"level"`
	Count         int64  `json:"count"`
	FirstSeen     string `json:"firstSeen"`
	LastSeen      string `json:"lastSeen"`
	LatestEventID string `json:"latestEventId"`
	Status        string `json:"status"`
	Truncated     bool   `json:"truncated,omitempty"`
}

func (h *Handler) issues(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	since := p.timeParam("since", p.now.Add(-7*24*time.Hour))
	limit := p.limit()
	level := p.str("level", 32)
	text := p.str("text", 200)
	release := p.str("release", 200)
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	q := `SELECT group_key, coalesce(title,''), coalesce(level,''), count,
		first_seen_ms, last_seen_ms, coalesce(latest_event_id,''), status
		FROM issues i WHERE resource_id = ? AND last_seen_ms >= ?`
	args := []any{trc, since.UnixMilli()}
	if release != "" {
		// Groups with at least one stored event of this release; count and
		// first/last seen stay the group's (events_res_group serves the probe).
		q += " AND EXISTS (SELECT 1 FROM events e WHERE e.resource_id = i.resource_id AND e.group_key = i.group_key AND e.release = ?)"
		args = append(args, release)
	}
	if level != "" {
		q += " AND level = ?"
		args = append(args, level)
	}
	if text != "" {
		q += ` AND title LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(text)+"%")
	}
	q += " ORDER BY last_seen_ms DESC LIMIT ?"
	args = append(args, limit)
	rows, err := h.opt.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		h.fail(w, err)
		return
	}
	defer rows.Close()
	out := []Issue{}
	for rows.Next() {
		var i Issue
		var first, last int64
		if err := rows.Scan(&i.GroupKey, &i.Title, &i.Level, &i.Count, &first, &last, &i.LatestEventID, &i.Status); err != nil {
			h.fail(w, err)
			return
		}
		i.FirstSeen, i.LastSeen = rfc(first), rfc(last)
		i.Title, i.Truncated = clip(i.Title, MaxString)
		out = append(out, i)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": out})
}

// TagValue is one value of a tag distribution.
type TagValue struct {
	Value string `json:"value"`
	Count int64  `json:"count"`
}

func (h *Handler) issueTags(w http.ResponseWriter, r *http.Request, trc string) {
	group := r.PathValue("group")
	p := h.params(r)
	since := p.timeParam("since", p.now.Add(-7*24*time.Hour))
	if p.err == nil && (len(group) != 32 || !isHex(group)) {
		p.err = badParam("group", "a 32-hex groupKey")
	}
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	rows, err := h.opt.DB.QueryContext(r.Context(), `SELECT t.key, t.value, count(*) c FROM event_tags t
		JOIN events e ON e.id = t.event_row
		WHERE e.resource_id = ? AND e.group_key = ? AND e.received_ms >= ? GROUP BY t.key, t.value ORDER BY t.key, c DESC LIMIT 5000`,
		trc, group, since.UnixMilli())
	if err != nil {
		h.fail(w, err)
		return
	}
	defer rows.Close()
	tags := map[string][]TagValue{}
	for rows.Next() {
		var k, v string
		var c int64
		if err := rows.Scan(&k, &v, &c); err != nil {
			h.fail(w, err)
			return
		}
		if _, seen := tags[k]; !seen && len(tags) >= TagKeysLimit {
			continue
		}
		if len(tags[k]) < TagValuesLimit {
			tags[k] = append(tags[k], TagValue{Value: v, Count: c})
		}
	}
	if err := rows.Err(); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groupKey": group, "tags": tags})
}

// ---- events ----

// EventRow is a list entry.
type EventRow struct {
	EventID     string `json:"eventId"`
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	Received    string `json:"received"`
	Level       string `json:"level"`
	Title       string `json:"title"`
	Release     string `json:"release,omitempty"`
	Dist        string `json:"dist,omitempty"`
	Environment string `json:"environment,omitempty"`
	TraceID     string `json:"traceId,omitempty"`
	UserID      string `json:"userId,omitempty"`
	Device      string `json:"device,omitempty"`
	OS          string `json:"os,omitempty"`
	GroupKey    string `json:"groupKey,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
	receivedMs  int64
}

const eventCols = `e.event_id, e.type, e.ts_ms, e.received_ms, coalesce(e.level,''), coalesce(e.title,''),
	coalesce(e.release,''), coalesce(e.dist,''), coalesce(e.environment,''), coalesce(e.trace_id,''),
	coalesce(e.user_id,''), coalesce(e.device,''), coalesce(e.os,''), coalesce(e.group_key,'')`

func scanEventWithID(s interface{ Scan(...any) error }, id *int64) (EventRow, error) {
	var e EventRow
	var ts int64
	err := s.Scan(&e.EventID, &e.Type, &ts, &e.receivedMs, &e.Level, &e.Title, &e.Release, &e.Dist, &e.Environment,
		&e.TraceID, &e.UserID, &e.Device, &e.OS, &e.GroupKey, id)
	e.Timestamp, e.Received = rfc(ts), rfc(e.receivedMs)
	e.Title, e.Truncated = clip(e.Title, MaxString)
	return e, err
}

// eventID normalizes a pasted id: dashes removed, lowercase.
func eventID(s string) string { return strings.ToLower(strings.ReplaceAll(s, "-", "")) }

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (h *Handler) events(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	since := p.timeParam("since", p.now.Add(-DefaultSince))
	until := p.timeParam("until", p.now.Add(time.Hour))
	p.span(since, until)
	limit := p.limit()
	level := p.str("level", 32)
	text := p.str("text", 200)
	release := p.str("release", 200)
	device := p.str("device", 200)
	traceID := strings.ToLower(p.str("traceId", 64))
	typ := p.str("type", 16)
	group := p.str("group", 64)
	tk, tv, hasTag := p.pair("tag")
	cms, cid, hasCursor := p.cursor()
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	// since/until select by receive time (server clock): a device with a wrong
	// clock still shows up in "the last 10 minutes" (docs/tracer.md _Read API_).
	q := `SELECT ` + eventCols + ` FROM events e WHERE e.resource_id = ? AND e.received_ms >= ? AND e.received_ms < ?`
	args := []any{trc, since.UnixMilli(), until.UnixMilli()}
	add := func(cond string, v ...any) { q += " AND " + cond; args = append(args, v...) }
	if level != "" {
		add("e.level = ?", level)
	}
	if release != "" {
		add("e.release = ?", release)
	}
	if device != "" {
		add("e.device = ?", device)
	}
	if traceID != "" {
		add("e.trace_id = ?", traceID)
	}
	if typ != "" {
		add("e.type = ?", typ)
	}
	if group != "" {
		add("e.group_key = ?", group)
	}
	if text != "" {
		like := "%" + escapeLike(text) + "%"
		add(`(e.title LIKE ? ESCAPE '\' OR e.message LIKE ? ESCAPE '\')`, like, like)
	}
	if hasTag {
		add("EXISTS (SELECT 1 FROM event_tags t WHERE t.event_row = e.id AND t.key = ? AND t.value = ?)", tk, tv)
	}
	if hasCursor {
		add("(e.received_ms < ? OR (e.received_ms = ? AND e.id < ?))", cms, cms, cid)
	}
	// Pages follow receive order (the filter's clock), newest first; `next`
	// is the cursor of the following page when this one is full.
	q = strings.Replace(q, `SELECT `+eventCols, `SELECT `+eventCols+`, e.id`, 1)
	q += " ORDER BY e.received_ms DESC, e.id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := h.opt.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		h.fail(w, err)
		return
	}
	defer rows.Close()
	out := []EventRow{}
	var lastMs, lastID int64
	for rows.Next() {
		e, err := scanEventWithID(rows, &lastID)
		if err != nil {
			h.fail(w, err)
			return
		}
		lastMs = e.receivedMs
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, err)
		return
	}
	body := map[string]any{"events": out}
	if len(out) == limit {
		body["next"] = nextCursor(lastMs, lastID)
	}
	writeJSON(w, http.StatusOK, body)
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// Breadcrumb is one breadcrumb of an event.
type Breadcrumb struct {
	Timestamp string          `json:"timestamp,omitempty"`
	Type      string          `json:"type,omitempty"`
	Category  string          `json:"category,omitempty"`
	Level     string          `json:"level,omitempty"`
	Message   string          `json:"message,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Truncated bool            `json:"truncated,omitempty"`
}

// AttachmentRow lists an attachment (bytes come from /attachments/{id}).
type AttachmentRow struct {
	ID             string `json:"id"`
	Filename       string `json:"filename,omitempty"`
	ContentType    string `json:"contentType,omitempty"`
	AttachmentType string `json:"attachmentType,omitempty"`
	Size           int64  `json:"size"`
	SHA256         string `json:"sha256"`
}

// Frame is one stack frame of the raised exception (innermost last).
type Frame struct {
	Function string `json:"function,omitempty"`
	Module   string `json:"module,omitempty"`
	Filename string `json:"filename,omitempty"`
	Lineno   int    `json:"lineno,omitempty"`
	Colno    int    `json:"colno,omitempty"`
	InApp    bool   `json:"inApp,omitempty"`
}

// ExceptionValue is one exception of the chain. Mechanism tells a crash
// (`handled: false`) from a caught error.
type ExceptionValue struct {
	Type      string     `json:"type,omitempty"`
	Value     string     `json:"value,omitempty"`
	Mechanism *Mechanism `json:"mechanism,omitempty"`
	Frames    []Frame    `json:"frames,omitempty"`
}

// Mechanism is how the exception was captured.
type Mechanism struct {
	Type    string `json:"type,omitempty"`
	Handled *bool  `json:"handled,omitempty"`
}

// EventDetail is one event with everything the agent needs.
type EventDetail struct {
	EventRow
	Message           string                     `json:"message,omitempty"`
	Platform          string                     `json:"platform,omitempty"`
	AssociatedEventID string                     `json:"associatedEventId,omitempty"`
	Exception         []ExceptionValue           `json:"exception,omitempty"`
	Tags              map[string]string          `json:"tags"`
	Contexts          map[string]json.RawMessage `json:"contexts,omitempty"`
	Extra             json.RawMessage            `json:"extra,omitempty"`
	SDK               json.RawMessage            `json:"sdk,omitempty"`
	Fingerprint       []string                   `json:"fingerprint,omitempty"`
	// Omitted lists detail fields left out for size (each over 16 KiB).
	Omitted     []string        `json:"omitted,omitempty"`
	Breadcrumbs []Breadcrumb    `json:"breadcrumbs"`
	Attachments []AttachmentRow `json:"attachments"`
}

func (h *Handler) event(w http.ResponseWriter, r *http.Request, trc string) {
	id := eventID(r.PathValue("id"))
	ctx := r.Context()
	row := h.opt.DB.QueryRowContext(ctx, `SELECT `+eventCols+`, e.id, coalesce(e.message,''), coalesce(e.platform,''),
		coalesce(e.associated_event_id,''), e.json FROM events e WHERE e.resource_id = ? AND e.event_id = ?`, trc, id)
	var d EventDetail
	var rowID int64
	var raw string
	var ts, recv int64
	err := row.Scan(&d.EventID, &d.Type, &ts, &recv, &d.Level, &d.Title, &d.Release, &d.Dist, &d.Environment,
		&d.TraceID, &d.UserID, &d.Device, &d.OS, &d.GroupKey, &rowID, &d.Message, &d.Platform, &d.AssociatedEventID, &raw)
	if err != nil {
		h.fail(w, err)
		return
	}
	d.Timestamp, d.Received = rfc(ts), rfc(recv)
	var m struct {
		Exception   json.RawMessage            `json:"exception"`
		Contexts    map[string]json.RawMessage `json:"contexts"`
		Extra       json.RawMessage            `json:"extra"`
		SDK         json.RawMessage            `json:"sdk"`
		Fingerprint []string                   `json:"fingerprint"`
	}
	_ = json.Unmarshal([]byte(raw), &m)
	d.Exception = exceptions(m.Exception)
	d.Message, d.Truncated = clip(d.Message, MaxString*4)
	d.Fingerprint = m.Fingerprint
	if len(d.Fingerprint) > 32 {
		d.Fingerprint = d.Fingerprint[:32]
	}
	var sdk struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.Unmarshal(m.SDK, &sdk) == nil && sdk.Name != "" {
		d.SDK, _ = json.Marshal(sdk) // packages and integrations left out
	}
	d.Contexts = map[string]json.RawMessage{}
	for k, v := range m.Contexts {
		if len(v) > MaxRawJSON {
			d.Omitted = append(d.Omitted, "contexts."+k)
			continue
		}
		d.Contexts[k] = v
	}
	if len(m.Extra) > MaxRawJSON {
		d.Omitted = append(d.Omitted, "extra")
	} else {
		d.Extra = m.Extra
	}
	sort.Strings(d.Omitted)
	d.Tags = map[string]string{}
	if err := h.collect(ctx, `SELECT key, value FROM event_tags WHERE event_row = ?`, []any{rowID}, func(s scanner) error {
		var k, v string
		if err := s.Scan(&k, &v); err != nil {
			return err
		}
		d.Tags[k] = v
		return nil
	}); err != nil {
		h.fail(w, err)
		return
	}
	d.Breadcrumbs = []Breadcrumb{}
	if err := h.collect(ctx, `SELECT ts_ms, coalesce(type,''), coalesce(category,''), coalesce(level,''), coalesce(message,''), coalesce(data_json,'')
		FROM breadcrumbs WHERE event_row = ? ORDER BY id`, []any{rowID}, func(s scanner) error {
		var b Breadcrumb
		var ts sql.NullInt64
		var data string
		if err := s.Scan(&ts, &b.Type, &b.Category, &b.Level, &b.Message, &data); err != nil {
			return err
		}
		if ts.Valid {
			b.Timestamp = rfc(ts.Int64)
		}
		b.Message, b.Truncated = clip(b.Message, MaxString)
		if len(data) > MaxString {
			b.Truncated = true
		} else if data != "" {
			b.Data = json.RawMessage(data)
		}
		d.Breadcrumbs = append(d.Breadcrumbs, b)
		return nil
	}); err != nil {
		h.fail(w, err)
		return
	}
	d.Attachments, err = h.attachments(ctx, trc, id)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (h *Handler) attachments(ctx context.Context, trc, eventID string) ([]AttachmentRow, error) {
	out := []AttachmentRow{}
	err := h.collect(ctx, `SELECT blob_id, coalesce(filename,''), coalesce(content_type,''), coalesce(attachment_type,''), size, sha256
		FROM attachments WHERE resource_id = ? AND event_id = ? ORDER BY id`, []any{trc, eventID}, func(s scanner) error {
		var a AttachmentRow
		if err := s.Scan(&a.ID, &a.Filename, &a.ContentType, &a.AttachmentType, &a.Size, &a.SHA256); err != nil {
			return err
		}
		out = append(out, a)
		return nil
	})
	return out, err
}

// exceptions decodes the stored chain with the same bounded streaming
// decoder ingest uses (normalize.Exceptions).
func exceptions(raw json.RawMessage) []ExceptionValue {
	var out []ExceptionValue
	for _, v := range normalize.Exceptions(raw) {
		ev := ExceptionValue{Type: v.Type, Value: v.Value, Mechanism: mechanismOf(v.Mechanism)}
		ev.Value, _ = clip(ev.Value, MaxString)
		for _, fr := range v.Frames {
			var f struct {
				Function string `json:"function"`
				Module   string `json:"module"`
				Filename string `json:"filename"`
				Lineno   int    `json:"lineno"`
				Colno    int    `json:"colno"`
				InApp    bool   `json:"in_app"`
			}
			if json.Unmarshal(fr, &f) == nil {
				f.Function, _ = clip(f.Function, 300)
				f.Filename, _ = clip(f.Filename, 300)
				f.Module, _ = clip(f.Module, 300)
				ev.Frames = append(ev.Frames, Frame{Function: f.Function, Module: f.Module, Filename: f.Filename, Lineno: f.Lineno, Colno: f.Colno, InApp: f.InApp})
			}
		}
		out = append(out, ev)
	}
	return out
}

func mechanismOf(raw json.RawMessage) *Mechanism {
	var m Mechanism
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil || (m.Type == "" && m.Handled == nil) {
		return nil
	}
	m.Type, _ = clip(m.Type, 64)
	return &m
}

type scanner interface{ Scan(...any) error }

func (h *Handler) collect(ctx context.Context, q string, args []any, fn func(scanner) error) error {
	rows, err := h.opt.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// ---- logs ----

// LogRow is one log entry.
type LogRow struct {
	Timestamp   string          `json:"timestamp"`
	Received    string          `json:"received"`
	Level       string          `json:"level,omitempty"`
	Body        string          `json:"body"`
	TraceID     string          `json:"traceId,omitempty"`
	SpanID      string          `json:"spanId,omitempty"`
	Release     string          `json:"release,omitempty"`
	Environment string          `json:"environment,omitempty"`
	UserID      string          `json:"userId,omitempty"`
	Device      string          `json:"device,omitempty"`
	Attributes  json.RawMessage `json:"attributes,omitempty"`
	Truncated   bool            `json:"truncated,omitempty"`
}

const logCols = `id, received_ms, ts_ms, coalesce(level,''), coalesce(body,''), coalesce(trace_id,''), coalesce(span_id,''),
	coalesce(release,''), coalesce(environment,''), coalesce(user_id,''), coalesce(device,''), coalesce(attributes_json,'')`

func scanLog(s scanner, id, recv *int64) (LogRow, error) {
	var l LogRow
	var ts int64
	var attrs string
	err := s.Scan(id, recv, &ts, &l.Level, &l.Body, &l.TraceID, &l.SpanID, &l.Release, &l.Environment, &l.UserID, &l.Device, &attrs)
	l.Timestamp, l.Received = rfc(ts), rfc(*recv)
	if len(attrs) > MaxRawJSON {
		l.Truncated = true
	} else if attrs != "" {
		l.Attributes = json.RawMessage(attrs)
	}
	var cut bool
	l.Body, cut = clip(l.Body, MaxString)
	l.Truncated = l.Truncated || cut
	return l, err
}

func (h *Handler) logs(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	since := p.timeParam("since", p.now.Add(-DefaultSince))
	until := p.timeParam("until", p.now.Add(time.Hour))
	p.span(since, until)
	limit := p.limit()
	level := p.str("level", 32)
	text := p.str("text", 200)
	device := p.str("device", 200)
	traceID := strings.ToLower(p.str("traceId", 64))
	ak, av, hasAttr := p.pair("attr")
	cms, cid, hasCursor := p.cursor()
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	q := `SELECT ` + logCols + ` FROM logs WHERE resource_id = ? AND received_ms >= ? AND received_ms < ?`
	args := []any{trc, since.UnixMilli(), until.UnixMilli()}
	add := func(cond string, v ...any) { q += " AND " + cond; args = append(args, v...) }
	if level != "" {
		add("level = ?", level)
	}
	if device != "" {
		add("device = ?", device)
	}
	if traceID != "" {
		add("trace_id = ?", traceID)
	}
	if text != "" {
		add(`body LIKE ? ESCAPE '\'`, "%"+escapeLike(text)+"%")
	}
	if hasAttr {
		// Typed attributes {"k":{"value":…}}; bounded by the time range (docs/tracer.md).
		add(`(json_extract(attributes_json, '$."' || ? || '".value') = ? OR CAST(json_extract(attributes_json, '$."' || ? || '".value') AS TEXT) = ?)`, ak, av, ak, av)
	}
	if hasCursor {
		add("(received_ms < ? OR (received_ms = ? AND id < ?))", cms, cms, cid)
	}
	q += " ORDER BY received_ms DESC, id DESC LIMIT ?"
	args = append(args, limit)
	out := []LogRow{}
	var lastID, lastMs int64
	if err := h.collect(r.Context(), q, args, func(s scanner) error {
		l, err := scanLog(s, &lastID, &lastMs)
		if err == nil {
			out = append(out, l)
		}
		return err
	}); err != nil {
		h.fail(w, err)
		return
	}
	body := map[string]any{"logs": out}
	if len(out) == limit {
		body["next"] = nextCursor(lastMs, lastID)
	}
	writeJSON(w, http.StatusOK, body)
}

// ---- timeline ----

// TimelineEntry is one time-ordered thing around an event.
type TimelineEntry struct {
	Timestamp  string          `json:"timestamp"`
	Kind       string          `json:"kind"` // breadcrumb | log | event | feedback | transaction
	Type       string          `json:"type,omitempty"`
	Level      string          `json:"level,omitempty"`
	Category   string          `json:"category,omitempty"`
	Message    string          `json:"message,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
	Attributes json.RawMessage `json:"attributes,omitempty"`
	EventID    string          `json:"eventId,omitempty"`
	TraceID    string          `json:"traceId,omitempty"`
	SpanID     string          `json:"spanId,omitempty"`
	Truncated  bool            `json:"truncated,omitempty"`
	ms         int64
}

func (h *Handler) timeline(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	window := p.duration("window", DefaultWindow, MaxWindow)
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	ctx := r.Context()
	id := eventID(r.PathValue("id"))
	var rowID, ts int64
	var traceID, userID string
	if err := h.opt.DB.QueryRowContext(ctx, `SELECT id, ts_ms, coalesce(trace_id,''), coalesce(user_id,'')
		FROM events WHERE resource_id = ? AND event_id = ?`, trc, id).Scan(&rowID, &ts, &traceID, &userID); err != nil {
		h.fail(w, err)
		return
	}
	from, to := ts-window.Milliseconds(), ts+window.Milliseconds()
	out := []TimelineEntry{}
	truncated := false
	addEntry := func(e TimelineEntry) {
		e.Timestamp = rfc(e.ms)
		var cut bool
		e.Message, cut = clip(e.Message, MaxString)
		e.Truncated = e.Truncated || cut
		out = append(out, e)
	}
	// The event's own breadcrumbs (the device's trail up to it); a breadcrumb
	// without a timestamp is placed at the event.
	err := h.collect(ctx, `SELECT coalesce(ts_ms, ?), coalesce(type,''), coalesce(category,''), coalesce(level,''), coalesce(message,''), coalesce(data_json,'')
		FROM breadcrumbs WHERE event_row = ? ORDER BY id`, []any{ts, rowID}, func(s scanner) error {
		var e TimelineEntry
		var data string
		if err := s.Scan(&e.ms, &e.Type, &e.Category, &e.Level, &e.Message, &data); err != nil {
			return err
		}
		e.Kind = "breadcrumb"
		e.Data, e.Truncated = rawField(data)
		addEntry(e)
		return nil
	})
	// Rows of the same trace or the same installation (userId), each source
	// limited on both sides of the anchor so the anchor is never cut away.
	cond, cargs := sameSource(traceID, userID)
	side := func(q string, args []any, scan func(scanner) error) error {
		for _, half := range []struct {
			order  string
			lo, hi int64
		}{{"DESC", from, ts}, {"ASC", ts + 1, to}} {
			n := 0
			qq := strings.ReplaceAll(q, "{ORDER}", half.order)
			a := append(append([]any{trc, half.lo, half.hi}, args...), MaxTimelineSide)
			start := len(out)
			if err := h.collect(ctx, qq, a, func(s scanner) error { n++; return scan(s) }); err != nil {
				return err
			}
			if half.order == "DESC" { // back to arrival order before the stable sort
				for i, j := start, len(out)-1; i < j; i, j = i+1, j-1 {
					out[i], out[j] = out[j], out[i]
				}
			}
			if n == MaxTimelineSide {
				truncated = true
			}
		}
		return nil
	}
	if err == nil && cond != "" {
		err = side(`SELECT ts_ms, coalesce(level,''), coalesce(body,''), coalesce(trace_id,''), coalesce(span_id,''), coalesce(attributes_json,'') FROM logs
			WHERE resource_id = ? AND ts_ms BETWEEN ? AND ? AND (`+cond+`) ORDER BY ts_ms {ORDER}, id {ORDER} LIMIT ?`, cargs, func(s scanner) error {
			var e TimelineEntry
			var attrs string
			if err := s.Scan(&e.ms, &e.Level, &e.Message, &e.TraceID, &e.SpanID, &attrs); err != nil {
				return err
			}
			e.Kind = "log"
			e.Attributes, e.Truncated = rawField(attrs)
			addEntry(e)
			return nil
		})
	}
	// Neighbouring events and feedback; the anchor itself always.
	if err == nil {
		var ac string
		var aargs []any
		if cond != "" {
			ac, aargs = " OR "+cond, cargs
		}
		err = side(`SELECT ts_ms, type, coalesce(level,''), coalesce(title,''), event_id, coalesce(trace_id,'') FROM events
			WHERE resource_id = ? AND ts_ms BETWEEN ? AND ? AND (event_id = ?`+ac+`) ORDER BY ts_ms {ORDER}, id {ORDER} LIMIT ?`,
			append([]any{id}, aargs...), func(s scanner) error {
				var e TimelineEntry
				if err := s.Scan(&e.ms, &e.Kind, &e.Level, &e.Message, &e.EventID, &e.TraceID); err != nil {
					return err
				}
				addEntry(e)
				return nil
			})
	}
	if err == nil && traceID != "" {
		err = side(`SELECT start_ms, coalesce(name,''), coalesce(op,''), event_id, coalesce(trace_id,''), coalesce(end_ms, start_ms) FROM transactions
			WHERE resource_id = ? AND start_ms BETWEEN ? AND ? AND trace_id = ? ORDER BY start_ms {ORDER}, id {ORDER} LIMIT ?`,
			[]any{traceID}, func(s scanner) error {
				var e TimelineEntry
				var name, op string
				var end int64
				if err := s.Scan(&e.ms, &name, &op, &e.EventID, &e.TraceID, &end); err != nil {
					return err
				}
				e.Kind, e.Category = "transaction", op
				e.Message = name + " (" + strconv.FormatInt(end-e.ms, 10) + " ms)"
				addEntry(e)
				return nil
			})
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	sortTimeline(out)
	writeJSON(w, http.StatusOK, map[string]any{"eventId": id, "from": rfc(from), "to": rfc(to), "entries": out, "truncated": truncated})
}

// rawField returns stored JSON for output, or nothing (and truncated) when
// it is over the list bound.
func rawField(s string) (json.RawMessage, bool) {
	if s == "" {
		return nil, false
	}
	if len(s) > MaxString {
		return nil, true
	}
	return json.RawMessage(s), false
}

// sameSource matches rows of the same trace or the same installation
// (userId). A device model alone is shared by strangers, so it never joins
// rows; with neither id the timeline holds only the event and its trail.
func sameSource(traceID, userID string) (string, []any) {
	var conds []string
	var args []any
	if traceID != "" {
		conds = append(conds, "trace_id = ?")
		args = append(args, traceID)
	}
	if userID != "" {
		conds = append(conds, "user_id = ?")
		args = append(args, userID)
	}
	return strings.Join(conds, " OR "), args
}

// sortTimeline orders by time; entries of one instant keep query order
// (breadcrumbs, logs, events, transactions).
func sortTimeline(es []TimelineEntry) {
	sort.SliceStable(es, func(i, j int) bool { return es[i].ms < es[j].ms })
}

// ---- attachment bytes ----

func (h *Handler) attachment(w http.ResponseWriter, r *http.Request, trc string) {
	id := r.PathValue("id")
	var path, sum, filename string
	var size int64
	err := h.opt.DB.QueryRowContext(r.Context(), `SELECT path, sha256, size, coalesce(filename,'') FROM attachments WHERE resource_id = ? AND blob_id = ?`,
		trc, id).Scan(&path, &sum, &size, &filename)
	if err != nil {
		h.fail(w, err)
		return
	}
	abs := filepath.Join(h.opt.BlobDir, filepath.Clean("/"+path))
	f, err := os.Open(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not_found", "attachment file is gone (retention)")
			return
		}
		h.fail(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+id+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Tracer-Sha256", sum)
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, io.LimitReader(f, size))
}

// ---- drops and usage ----

// DropRow is one day's count per item type and reason.
type DropRow struct {
	Day      string `json:"day"`
	ItemType string `json:"itemType"`
	Reason   string `json:"reason"`
	Count    int64  `json:"count"`
	Bytes    int64  `json:"bytes"`
}

func (h *Handler) drops(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	days := p.days()
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	from := p.now.UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	out := []DropRow{}
	if err := h.collect(r.Context(), `SELECT day, item_type, reason, count, bytes FROM drops WHERE resource_id = ? AND day >= ?
		ORDER BY day DESC, reason, item_type`, []any{trc, from}, func(s scanner) error {
		var d DropRow
		if err := s.Scan(&d.Day, &d.ItemType, &d.Reason, &d.Count, &d.Bytes); err != nil {
			return err
		}
		out = append(out, d)
		return nil
	}); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"drops": out})
}

// UsageRow is one UTC day of accepted bytes.
type UsageRow struct {
	Day      string  `json:"day"`
	Bytes    int64   `json:"bytes"`
	QuotaHit *string `json:"quotaHit"`
}

func (h *Handler) usage(w http.ResponseWriter, r *http.Request, trc string) {
	p := h.params(r)
	days := p.days()
	if p.err != nil {
		h.fail(w, p.err)
		return
	}
	from := p.now.UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	out := []UsageRow{}
	if err := h.collect(r.Context(), `SELECT day, bytes, quota_hit_ms FROM daily_bytes WHERE resource_id = ? AND day >= ? ORDER BY day DESC`,
		[]any{trc, from}, func(s scanner) error {
			var u UsageRow
			var hit sql.NullInt64
			if err := s.Scan(&u.Day, &u.Bytes, &hit); err != nil {
				return err
			}
			u.QuotaHit = rfcNull(hit)
			out = append(out, u)
			return nil
		}); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": out})
}

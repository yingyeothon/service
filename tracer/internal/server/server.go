// Package server is tracer's HTTP front: `/livez`, `/healthz`, `/metrics`,
// then the ingest mux (`/api/…`) and, from todo/85 P6, the read mux (`/v1/…`).
// The two muxes stay separate: a write key is never a read credential.
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/store"
)

// Version is set by main (build-time ldflags).
var Version = "dev"

// Prober reports whether the database accepts a write.
type Prober interface {
	Writable(ctx context.Context) error
}

// Options configures a Server.
type Options struct {
	Stage string
	Mode  string
	DB    Prober
	// Ingest serves `/api/…`; Read serves `/v1/…` (nil until P6).
	Ingest http.Handler
	Read   http.Handler
	// Metrics renders publicly; Detailed is served for OperatorToken only.
	Metrics json.Marshaler
	Detail  func() any
	// OperatorToken is the `tracer-token` (empty in local mode: no detail).
	OperatorToken string
	// Ready reports readiness beyond the DB (console `/tr/health`, P5);
	// nil means ready.
	Ready func(ctx context.Context) (string, bool)
	// UsageDB (read-only) serves console `GET /tr/usage` to the operator
	// bearer; nil (local mode) leaves the route out.
	UsageDB *sql.DB
	// Now defaults to time.Now (UTC days of `/tr/usage`).
	Now func() time.Time
	// ReadOrigins get CORS on `/v1/` only (TRACER_READ_ORIGINS).
	ReadOrigins []string
}

// Server is the composed handler.
type Server struct {
	opt     Options
	opToken []byte
	started time.Time
	mux     *http.ServeMux

	// The write probe behind the public `/livez`, shared for livezEvery so a
	// flood of probes cannot compete with ingest for the single writer.
	liveMu  sync.Mutex
	liveAt  time.Time
	liveErr error
}

// livezEvery is how long one DB write probe answers `/livez`.
const livezEvery = time.Second

func (s *Server) writable(ctx context.Context) error {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if !s.liveAt.IsZero() && time.Since(s.liveAt) < livezEvery {
		return s.liveErr
	}
	// Detached from the caller: one client hanging up must not become a
	// cached "unwritable" for everyone (the 2 s bound still applies).
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	s.liveErr = s.opt.DB.Writable(pctx)
	s.liveAt = time.Now()
	return s.liveErr
}

// New composes the routes.
func New(opt Options) *Server {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	s := &Server{opt: opt, started: time.Now(), mux: http.NewServeMux()}
	if opt.OperatorToken != "" {
		sum := sha256.Sum256([]byte(opt.OperatorToken))
		s.opToken = sum[:]
	}
	s.mux.HandleFunc("GET /livez", s.livez)
	s.mux.HandleFunc("GET /healthz", s.healthz)
	s.mux.HandleFunc("GET /metrics", s.metrics)
	if opt.UsageDB != nil && s.opToken != nil {
		s.mux.HandleFunc("GET /tr/usage", s.usage)
	}
	if opt.Ingest != nil {
		s.mux.Handle("/api/", opt.Ingest)
	}
	if opt.Read != nil {
		s.mux.Handle("/v1/", readCORS(opt.ReadOrigins, opt.Read))
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// livez: the process is up and the DB takes a write. Restarts wire to this,
// never to /healthz (a console redeploy must not restart tracer).
func (s *Server) livez(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.writable(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"service": "yyt-tracer", "live": false, "db": "unwritable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service": "yyt-tracer", "live": true, "version": Version})
}

// healthz is readiness: the DB takes a write and, in server mode, the console
// answers `/tr/health` (P5).
func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	status := http.StatusOK
	body := map[string]any{"service": "yyt-tracer", "version": Version, "stage": s.opt.Stage, "mode": s.opt.Mode,
		"uptimeSec": int(time.Since(s.started).Seconds()), "db": "ok", "console": "n/a"}
	if err := s.writable(ctx); err != nil {
		body["db"], status = "unwritable", http.StatusServiceUnavailable
	}
	if s.opt.Ready != nil {
		state, ok := s.opt.Ready(ctx)
		body["console"] = state
		if !ok {
			status = http.StatusServiceUnavailable
		}
	}
	writeJSON(w, status, body)
}

// operator reports whether the request carries the `tracer-token` bearer.
func (s *Server) operator(r *http.Request) bool {
	if s.opToken == nil {
		return false
	}
	b, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || b == "" {
		return false
	}
	sum := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(sum[:], s.opToken) == 1
}

// consoleIDPattern is the id shape the console mints and its usage client accepts.
var consoleIDPattern = regexp.MustCompile(`^trc_[0-9a-z]{26}$`)

// Bounds of `GET /tr/usage` (services/console/src/tracer-usage.ts).
const (
	usageMaxIDs  = 100
	usageMaxDays = 7
)

// usage is console → tracer `GET /tr/usage?ids=&days=` or `?quotaDay=`:
// per-resource UTC daily bytes and quota drops, for the limits page, the
// admin approval view and the daily digest.
func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	if !s.operator(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "tracer token required"}})
		return
	}
	bad := func(msg string) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "bad_request", "message": msg}})
	}
	q := r.URL.Query()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var got map[string][]store.UsageDay
	var err error
	switch {
	case q.Has("quotaDay") && !q.Has("ids") && !q.Has("days"):
		day := q.Get("quotaDay")
		if _, perr := time.Parse("2006-01-02", day); perr != nil || len(q["quotaDay"]) != 1 {
			bad("quotaDay must be one YYYY-MM-DD")
			return
		}
		got, err = store.QuotaHits(ctx, s.opt.UsageDB, day)
	case q.Has("ids") && !q.Has("quotaDay"):
		if len(q["ids"]) != 1 || len(q["days"]) > 1 {
			bad("ids and days are given once")
			return
		}
		ids, ok := usageIDs(q.Get("ids"))
		if !ok {
			bad("ids must be 1..100 comma-separated trc_ ids")
			return
		}
		days := 1
		if v := q.Get("days"); v != "" {
			n, perr := strconv.Atoi(v)
			if perr != nil || n < 1 || n > usageMaxDays {
				bad("days must be an integer in 1..7")
				return
			}
			days = n
		}
		today := s.opt.Now().UTC()
		list := make([]string, days)
		for i := range list {
			list[i] = today.AddDate(0, 0, -i).Format("2006-01-02")
		}
		got, err = store.Usage(ctx, s.opt.UsageDB, ids, list)
	default:
		bad("give ids (with days) or quotaDay")
		return
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"code": "unavailable", "message": "usage read failed"}})
		return
	}
	// The console's schema takes only its own id shape and drops the whole
	// answer on one stranger (a data dir once used in local mode).
	for id := range got {
		if !consoleIDPattern.MatchString(id) {
			delete(got, id)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": got})
}

func usageIDs(raw string) ([]string, bool) {
	parts := strings.Split(raw, ",")
	if raw == "" || len(parts) > usageMaxIDs {
		return nil, false
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if !config.ResourceIDPattern.MatchString(p) {
			return nil, false
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out, true
}

// metrics serves the process-wide numbers to anyone and the per-resource
// slice only with the operator bearer (resource ids are targeting material).
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if s.opt.Detail != nil && s.operator(r) {
		writeJSON(w, http.StatusOK, s.opt.Detail())
		return
	}
	writeJSON(w, http.StatusOK, s.opt.Metrics)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// readCORS lets the stage's console SPA read `/v1/` with a bearer
// (decisions _Debug collector_ #12). It wraps the whole read handler, so the
// headers are set before routing, the address limiter and authz run: a 401,
// 404 or limiter 503 (with its `Retry-After`) is readable by the page too.
// Exact origins only, no credentials (the bearer is not a cookie); every
// other route of the server stays without CORS.
func readCORS(origins []string, next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		ok := origin != "" && allowed[origin]
		if ok {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Expose-Headers", "Retry-After, X-Tracer-Sha256")
		}
		// A preflight carries no credentials: answer it before any limiter
		// or authz, so it neither spends nor needs a failure budget.
		if r.Method == http.MethodOptions {
			if ok {
				h.Set("Access-Control-Allow-Methods", "GET")
				h.Set("Access-Control-Allow-Headers", "Authorization")
				h.Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

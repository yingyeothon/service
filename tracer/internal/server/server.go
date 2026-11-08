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
}

// Server is the composed handler.
type Server struct {
	opt     Options
	opToken []byte
	started time.Time
	mux     *http.ServeMux
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
		s.mux.Handle("/v1/", opt.Read)
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// livez: the process is up and the DB takes a write. Restarts wire to this,
// never to /healthz (a console redeploy must not restart tracer).
func (s *Server) livez(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.opt.DB.Writable(ctx); err != nil {
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
	if err := s.opt.DB.Writable(ctx); err != nil {
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

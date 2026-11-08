// Package server is tracer's HTTP front: `/livez`, `/healthz`, `/metrics`,
// then the ingest mux (`/api/…`) and, from todo/85 P6, the read mux (`/v1/…`).
// The two muxes stay separate: a write key is never a read credential.
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"
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
	s := &Server{opt: opt, started: time.Now(), mux: http.NewServeMux()}
	if opt.OperatorToken != "" {
		sum := sha256.Sum256([]byte(opt.OperatorToken))
		s.opToken = sum[:]
	}
	s.mux.HandleFunc("GET /livez", s.livez)
	s.mux.HandleFunc("GET /healthz", s.healthz)
	s.mux.HandleFunc("GET /metrics", s.metrics)
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

// metrics serves the process-wide numbers to anyone and the per-resource
// slice only with the operator bearer (resource ids are targeting material).
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if s.opToken != nil && s.opt.Detail != nil {
		auth := r.Header.Get("Authorization")
		if b, ok := strings.CutPrefix(auth, "Bearer "); ok && b != "" {
			sum := sha256.Sum256([]byte(b))
			if subtle.ConstantTimeCompare(sum[:], s.opToken) == 1 {
				writeJSON(w, http.StatusOK, s.opt.Detail())
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, s.opt.Metrics)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

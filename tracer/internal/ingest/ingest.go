// Package ingest is the Sentry-compatible HTTP surface: health, envelope and
// legacy store endpoints. It authenticates the DSN write key, then hands the
// body to envelope + store. The write key never authorizes any read.
package ingest

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/yingyeothon/service/tracer/internal/config"
)

// Handler serves the ingest routes.
type Handler struct {
	cfg *config.Config
	mux *http.ServeMux
}

// New builds the ingest handler.
func New(cfg *config.Config) *Handler {
	h := &Handler{cfg: cfg, mux: http.NewServeMux()}
	h.mux.HandleFunc("GET /healthz", h.health)
	h.mux.HandleFunc("POST /api/{project}/envelope/{$}", h.envelope)
	h.mux.HandleFunc("POST /api/{project}/store/{$}", h.store)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("ok\n"))
}

func (h *Handler) envelope(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.authorize(w, r); !ok {
		return
	}
	// Phase 1: decompress (gzip/deflate/br) with the MaxEnvelopeBytes cap,
	// envelope.Parse, store, then 200 {"id": event_id}.
	writeJSON(w, http.StatusNotImplemented, map[string]string{"detail": "envelope ingest not implemented yet"})
}

func (h *Handler) store(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.authorize(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{"detail": "store ingest not implemented yet"})
}

// authorize resolves the project from the path and checks the DSN key. Unknown
// project and wrong key both answer 401 so project ids cannot be probed.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) (config.Project, bool) {
	id, err := strconv.Atoi(r.PathValue("project"))
	p, found := h.cfg.ProjectByID(id)
	key := SentryKey(r)
	if err != nil || !found || key == "" || key != p.Key {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"detail": "invalid project or sentry_key"})
		return config.Project{}, false
	}
	return p, true
}

// SentryKey extracts sentry_key from X-Sentry-Auth
// ("Sentry sentry_key=<key>, sentry_version=7, ...") or the query string.
func SentryKey(r *http.Request) string {
	if auth := r.Header.Get("X-Sentry-Auth"); auth != "" {
		auth = strings.TrimSpace(auth)
		if len(auth) >= 7 && strings.EqualFold(auth[:7], "sentry ") {
			auth = auth[7:]
		}
		for _, part := range strings.Split(auth, ",") {
			k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
			if ok && strings.TrimSpace(k) == "sentry_key" {
				return strings.TrimSpace(v)
			}
		}
	}
	return r.URL.Query().Get("sentry_key")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// Package ingest is the envelope surface (`POST /api/{trc}/envelope/` and the
// legacy `/store/`). It authenticates the DSN write key against the resource's
// `writeKeySha256`, then hands the body to envelope + store. The write key
// never authorizes any read; the read API lives on another mux.
package ingest

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/resource"
)

// Options configures a Handler.
type Options struct {
	Source  resource.Source
	Metrics *metrics.Registry
	// MaxBodyBytes caps the request body as sent (compressed).
	MaxBodyBytes int64
	// DumpDir (local mode only) receives each accepted raw request.
	DumpDir string
	Log     *slog.Logger
	Now     func() time.Time
}

// Handler serves the ingest routes.
type Handler struct {
	opt   Options
	mux   *http.ServeMux
	dumps atomic.Int64
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
		opt.MaxBodyBytes = config.DefaultMaxEnvelopeBytes
	}
	h := &Handler{opt: opt, mux: http.NewServeMux()}
	h.mux.HandleFunc("POST /api/{resource}/envelope/{$}", h.envelope)
	h.mux.HandleFunc("POST /api/{resource}/store/{$}", h.envelope)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

func (h *Handler) envelope(w http.ResponseWriter, r *http.Request) {
	res, status := h.authorize(r)
	if status != 0 {
		h.reject(w, status)
		return
	}
	if h.opt.DumpDir != "" {
		if err := h.dump(r, res.ID); err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				h.reject(w, http.StatusRequestEntityTooLarge)
				return
			}
			h.opt.Log.Warn("dump failed", "resource", res.ID, "err", err)
			h.reject(w, http.StatusServiceUnavailable)
			return
		}
		h.opt.Metrics.Counters.EnvelopesAccepted.Add(1)
		writeJSON(w, http.StatusOK, map[string]string{})
		return
	}
	// todo/85 P3: decompress under the cap, envelope.Parse, store, 200 {"id"}.
	writeJSON(w, http.StatusNotImplemented, map[string]string{"detail": "envelope ingest not implemented yet"})
}

// authorize resolves the resource and checks the write key. An unknown or
// inactive resource and a wrong key answer the same 401, so ids cannot be
// probed. A resource source failure (console unreachable) is a 503.
func (h *Handler) authorize(r *http.Request) (resource.Resource, int) {
	id := r.PathValue("resource")
	if !config.ResourceIDPattern.MatchString(id) {
		return resource.Resource{}, http.StatusUnauthorized
	}
	key := SentryKey(r)
	res, err := h.opt.Source.Lookup(r.Context(), id)
	switch {
	case errors.Is(err, resource.ErrNotFound):
		return res, http.StatusUnauthorized
	case err != nil:
		h.opt.Log.Warn("resource lookup failed", "resource", id, "err", err)
		return res, http.StatusServiceUnavailable
	}
	if !res.KeyMatches(key) || !res.Active() {
		return res, http.StatusUnauthorized
	}
	return res, 0
}

func (h *Handler) reject(w http.ResponseWriter, status int) {
	h.opt.Metrics.Counters.CountRejection(status)
	detail := map[int]string{
		http.StatusUnauthorized:          "invalid resource or sentry_key",
		http.StatusRequestEntityTooLarge: "envelope too large",
		http.StatusServiceUnavailable:    "temporarily unavailable",
	}[status]
	writeJSON(w, status, map[string]string{"detail": detail})
}

// dump writes the raw body and the request line + headers (credentials
// removed) for fixture capture (todo/85 P2). Files are 0600 and must be
// scrubbed before anything reaches testdata.
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
func ScrubHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for k, v := range h {
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
	for i, p := range parts {
		if isCredentialParam(p.name) {
			parts[i].value = "<redacted>"
		}
	}
	out := make([]string, len(parts))
	for i, p := range parts {
		if p.hasValue {
			out[i] = p.name + "=" + p.value
		} else {
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

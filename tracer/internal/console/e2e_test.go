package console

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/ingest"
	"github.com/yingyeothon/service/tracer/internal/query"
	"github.com/yingyeothon/service/tracer/internal/server"
	"github.com/yingyeothon/service/tracer/internal/store"
)

// Server mode wired as cmd/tracer does it: ingest and the read API ask the
// fake console; `/healthz` reports it; `/tr/usage` answers the operator.
func TestServerModeEndToEnd(t *testing.T) {
	f := newFake(t)
	c, ck, reg := newClient(t, f, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	st, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	w := st.StartWriter(ctx)
	ro, err := store.OpenReadOnly(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); <-w.Done(); ro.Close(); st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ing := ingest.New(ingest.Options{Source: c, Metrics: reg, Writer: w, DailyBytes: st.DailyBytes,
		BlobDir: filepath.Join(dir, "blobs"), Log: log, Now: ck.now})
	read := query.New(query.Options{DB: ro, BlobDir: filepath.Join(dir, "blobs"), Auth: c, Metrics: reg, Log: log, Now: ck.now})
	srv := httptest.NewServer(server.New(server.Options{Stage: "dev", Mode: "server", DB: st, Ingest: ing, Read: read,
		Metrics: reg, Detail: reg.Detailed, OperatorToken: token, Ready: c.Health, UsageDB: ro, Now: ck.now}))
	defer srv.Close()

	do := func(method, path string, body []byte, hdr map[string]string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	ts := ck.now().Format(time.RFC3339)
	ev := []byte(`{"event_id":"0123456789abcdef0123456789abcdef","sent_at":"` + ts + `"}` + "\n" +
		`{"type":"event"}` + "\n" +
		`{"event_id":"0123456789abcdef0123456789abcdef","timestamp":"` + ts + `","level":"warning","message":"hello"}` + "\n")
	key := map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + writeKey + ", sentry_version=7"}

	if s, b := do("POST", "/api/"+resID+"/envelope/", ev, key); s != 200 {
		t.Fatalf("ingest %d %s", s, b)
	}
	if s, _ := do("POST", "/api/"+goneID+"/envelope/", ev, key); s != 401 {
		t.Fatalf("deleted resource ingest %d", s)
	}
	if s, _ := do("POST", "/api/"+resID+"/envelope/", ev, map[string]string{"X-Sentry-Auth": "Sentry sentry_key=wrongwrongwrong1"}); s != 401 {
		t.Fatalf("wrong key %d", s)
	}

	bearer := func(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }
	s, b := do("GET", "/v1/"+resID+"/events?since=1h", nil, bearer(readTok))
	if s != 200 || !bytes.Contains([]byte(b), []byte("hello")) {
		t.Fatalf("read %d %s", s, b)
	}
	if s, _ := do("GET", "/v1/"+resID+"/events", nil, bearer(badTok)); s != 401 {
		t.Fatalf("unknown token %d", s)
	}
	if s, _ := do("GET", "/v1/"+resID+"/events", nil, bearer(stranger)); s != 404 {
		t.Fatalf("denied %d", s)
	}

	if s, b := do("GET", "/healthz", nil, nil); s != 200 || !bytes.Contains([]byte(b), []byte(`"console":"ok"`)) {
		t.Fatalf("healthz %d %s", s, b)
	}

	// Usage: the console's contract (services/console/src/tracer-usage.ts).
	if s, _ := do("GET", "/tr/usage?ids="+resID+"&days=7", nil, nil); s != 401 {
		t.Fatalf("usage without bearer %d", s)
	}
	s, b = do("GET", "/tr/usage?ids="+resID+","+goneID+"&days=7", nil, bearer(token))
	var u struct {
		Usage map[string][]store.UsageDay `json:"usage"`
	}
	if s != 200 || json.Unmarshal([]byte(b), &u) != nil || len(u.Usage[resID]) != 1 || u.Usage[resID][0].Bytes <= 0 ||
		u.Usage[resID][0].Day != ck.now().Format("2006-01-02") || u.Usage[goneID] != nil {
		t.Fatalf("usage %d %s", s, b)
	}
	for _, q := range []string{"", "?ids=", "?ids=x", "?ids=" + resID + "&days=8", "?quotaDay=2026-13-01", "?quotaDay=2026-11-08&ids=" + resID} {
		if s, _ := do("GET", "/tr/usage"+q, nil, bearer(token)); s != 400 {
			t.Errorf("usage %q: %d", q, s)
		}
	}
	if s, b := do("GET", "/tr/usage?quotaDay="+ck.now().Format("2006-01-02"), nil, bearer(token)); s != 200 || b != "{\"usage\":{}}\n" {
		t.Fatalf("quotaDay %d %q", s, b)
	}

	// Console down past the config ttl: ingest rides the stale entry, reads fail closed.
	f.down.Store(true)
	ck.add(2 * time.Minute)
	if s, b := do("POST", "/api/"+resID+"/envelope/", ev, key); s != 200 {
		t.Fatalf("stale ingest %d %s", s, b)
	}
	if s, _ := do("GET", "/v1/"+resID+"/events", nil, bearer(readTok)); s != 503 {
		t.Fatalf("read while down %d", s)
	}
	if s, b := do("GET", "/healthz", nil, nil); s != 503 || !bytes.Contains([]byte(b), []byte(`"console":"unreachable"`)) {
		t.Fatalf("healthz down %d %s", s, b)
	}
	ck.add(25 * time.Hour)
	if s, _ := do("POST", "/api/"+resID+"/envelope/", ev, key); s != 503 {
		t.Fatalf("past stale window ingest must be 503, got %d", s)
	}
}

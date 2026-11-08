package query

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/ingest"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/store"
)

var update = flag.Bool("update", false, "rewrite testdata/read golden files")

const (
	readToken = "yyt_000000000000000000000000000000000000000000000001"
	resID     = "trc_fixture01"
)

// fixedNow is the receive time of every seeded envelope: a minute after the
// captures' device timestamps (2026-11-08T06:42Z).
var fixedNow = time.Date(2026, 11, 8, 6, 43, 0, 0, time.UTC)

type readEnv struct {
	srv   *httptest.Server
	st    *store.Store
	ro    interface{ Close() error }
	blobs string
}

func newReadEnv(t *testing.T) *readEnv {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "tracer.db")
	st, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	w := st.StartWriter(ctx)
	local, err := config.ParseLocal([]byte(`{"resources":[{"id":"` + resID + `","writeKey":"aaaaaaaaaaaaaaaaaaaa"},{"id":"trc_other01","writeKey":"bbbbbbbbbbbbbbbbbbbb"}],"readToken":"` + readToken + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	src := resource.NewLocal(local)
	blobs := filepath.Join(dir, "blobs")
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	ing := ingest.New(ingest.Options{Source: src, Writer: w, BlobDir: blobs, Log: quiet})
	res, _ := src.Lookup(ctx, resID)
	files, _ := filepath.Glob("../../testdata/envelopes/*/*.envelope")
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if _, err := ing.Accept(ctx, res, bytes.NewReader(b), fixedNow); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
	}
	ro, err := store.OpenReadOnly(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	h := New(Options{DB: ro, BlobDir: blobs, Auth: NewLocalAuthorizer(local.ReadToken, src), Log: quiet,
		Now: func() time.Time { return fixedNow.Add(time.Minute) }})
	srv := httptest.NewServer(h)
	t.Cleanup(func() { srv.Close(); ro.Close(); cancel(); <-w.Done(); st.Close() })
	return &readEnv{srv: srv, st: st, ro: ro, blobs: blobs}
}

func (e *readEnv) get(t *testing.T, path, token string) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, b
}

// Attachment ids are minted per run; golden files carry a placeholder (only
// inside the attachments array, so other ids still show drift).
var blobIDs = regexp.MustCompile(`("contentType": "[^"]*",\s*"filename": "[^"]*",\s*"id": )"[0-9a-f]{32}"`)

func golden(t *testing.T, name string, body []byte) {
	t.Helper()
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("%s: %v: %s", name, err, body)
	}
	pretty, _ := json.MarshalIndent(v, "", "  ")
	pretty = blobIDs.ReplaceAll(pretty, []byte(`$1"<blob>"`))
	pretty = append(pretty, '\n')
	path := filepath.Join("../../testdata/read", name+".json")
	if *update {
		if err := os.WriteFile(path, pretty, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run go test ./internal/query -update)", name, err)
	}
	if !bytes.Equal(want, pretty) {
		t.Errorf("%s drifted from %s:\n%s", name, path, pretty)
	}
}

const (
	reportID    = "7730857f6b4d4655aee7855244455e2d"
	exceptionID = "2f166ea5ffa64594a3938e8ef5559888"
)

func TestGoldenRoutes(t *testing.T) {
	e := newReadEnv(t)
	routes := map[string]string{
		"issues":          "/v1/" + resID + "/issues",
		"events":          "/v1/" + resID + "/events",
		"events-feedback": "/v1/" + resID + "/events?type=feedback",
		"events-tag":      "/v1/" + resID + "/events?tag=feature:board",
		"event-report":    "/v1/" + resID + "/events/" + reportID,
		"event-exception": "/v1/" + resID + "/events/" + exceptionID,
		"timeline-report": "/v1/" + resID + "/events/" + reportID + "/timeline?window=2m",
		"logs":            "/v1/" + resID + "/logs",
		"logs-attr":       "/v1/" + resID + "/logs?attr=square:e2",
		"drops":           "/v1/" + resID + "/drops",
		"usage":           "/v1/" + resID + "/usage",
	}
	for name, path := range routes {
		code, _, body := e.get(t, path, readToken)
		if code != 200 {
			t.Errorf("%s: %d %s", name, code, body)
			continue
		}
		golden(t, name, body)
	}
	// issue tags: the group of the report
	var ev struct {
		GroupKey string `json:"groupKey"`
	}
	_, _, body := e.get(t, "/v1/"+resID+"/events/"+reportID, readToken)
	json.Unmarshal(body, &ev)
	code, _, body := e.get(t, "/v1/"+resID+"/issues/"+ev.GroupKey+"/tags", readToken)
	if code != 200 || !strings.Contains(string(body), `"feature":[{"value":"board","count":1}]`) {
		t.Errorf("issue tags %d %s", code, body)
	}
}

func TestAttachmentDownload(t *testing.T) {
	e := newReadEnv(t)
	var ev EventDetail
	_, _, body := e.get(t, "/v1/"+resID+"/events/"+reportID, readToken)
	json.Unmarshal(body, &ev)
	if len(ev.Attachments) != 2 {
		t.Fatalf("attachments %+v", ev.Attachments)
	}
	for _, a := range ev.Attachments {
		code, h, b := e.get(t, "/v1/"+resID+"/attachments/"+a.ID, readToken)
		if code != 200 || int64(len(b)) != a.Size || h.Get("X-Tracer-Sha256") != a.SHA256 || h.Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("download %s: %d %d %v", a.ID, code, len(b), h)
		}
		if a.ContentType == "image/png" && !bytes.HasPrefix(b, []byte("\x89PNG")) {
			t.Fatal("png bytes")
		}
		// Another resource never sees it, even with a valid token.
		if code, _, _ := e.get(t, "/v1/trc_other01/attachments/"+a.ID, readToken); code != 404 {
			t.Fatalf("cross-resource download %d", code)
		}
	}
}

func TestAuthAndErrors(t *testing.T) {
	e := newReadEnv(t)
	cases := []struct {
		name, path, token string
		want              int
		code              string
	}{
		{"no token", "/v1/" + resID + "/events", "", 401, "unauthorized"},
		{"write key", "/v1/" + resID + "/events", "aaaaaaaaaaaaaaaaaaaa", 401, "unauthorized"},
		{"wrong token", "/v1/" + resID + "/events", "yyt_" + strings.Repeat("f", 48), 401, "unauthorized"},
		{"unknown resource", "/v1/trc_nope/events", readToken, 404, "not_found"},
		{"bad id shape", "/v1/nope/events", readToken, 404, "not_found"},
		{"unknown event", "/v1/" + resID + "/events/" + strings.Repeat("0", 32), readToken, 404, "not_found"},
		{"bad limit", "/v1/" + resID + "/events?limit=9999", readToken, 400, "bad_request"},
		{"bad since", "/v1/" + resID + "/events?since=yesterday", readToken, 400, "bad_request"},
		{"bad window", "/v1/" + resID + "/events/" + reportID + "/timeline?window=5h", readToken, 400, "bad_request"},
		{"no route", "/v1/" + resID + "/nothing", readToken, 404, "not_found"},
	}
	for _, c := range cases {
		code, _, body := e.get(t, c.path, c.token)
		var env struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		json.Unmarshal(body, &env)
		if code != c.want || env.Error.Code != c.code {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	// Empty local readToken refuses everything.
	a := NewLocalAuthorizer("", nil)
	if err := a.Authorize(context.Background(), "", resID); err != ErrUnauthenticated {
		t.Fatalf("empty token: %v", err)
	}
}

func TestReadPathCannotWrite(t *testing.T) {
	e := newReadEnv(t)
	db, err := store.OpenReadOnly(context.Background(), filepath.Join(filepath.Dir(e.blobs), "tracer.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO meta(k, v) VALUES ('x', 'y')`); err == nil {
		t.Fatal("read-only connection wrote")
	}
	if _, err := db.Exec(`DELETE FROM events`); err == nil {
		t.Fatal("read-only connection deleted")
	}
}

func TestBoundsAndSince(t *testing.T) {
	e := newReadEnv(t)
	_, _, body := e.get(t, "/v1/"+resID+"/events?limit=1", readToken)
	var r struct{ Events []EventRow }
	json.Unmarshal(body, &r)
	if len(r.Events) != 1 {
		t.Fatalf("limit: %d", len(r.Events))
	}
	// since selects by receive time: everything was received at fixedNow.
	_, _, body = e.get(t, "/v1/"+resID+"/events?since="+fixedNow.Add(time.Second).Format(time.RFC3339), readToken)
	json.Unmarshal(body, &r)
	if len(r.Events) != 0 {
		t.Fatalf("since after receive: %d", len(r.Events))
	}
	_, _, body = e.get(t, "/v1/"+resID+"/events?since=2m", readToken)
	json.Unmarshal(body, &r)
	if len(r.Events) != 4 {
		t.Fatalf("since 2m: %d", len(r.Events))
	}
	if s, cut := clip(strings.Repeat("가", 1000), MaxString); !cut || len(s) > MaxString {
		t.Fatal("clip")
	}
}

// A busy window must never cut the anchor event away (P6 review).
func TestTimelineKeepsAnchor(t *testing.T) {
	e := newReadEnv(t)
	var traceID string
	e.st.DB.QueryRow("SELECT trace_id FROM events WHERE event_id = ?", reportID).Scan(&traceID)
	var ts int64
	e.st.DB.QueryRow("SELECT ts_ms FROM events WHERE event_id = ?", reportID).Scan(&ts)
	tx, _ := e.st.DB.Begin()
	for i := 0; i < 1100; i++ {
		tx.Exec(`INSERT INTO logs (resource_id, ts_ms, received_ms, body, trace_id, dedupe_key) VALUES (?,?,?,?,?,?)`,
			resID, ts-60_000+int64(i), ts, "busy", traceID, []byte{byte(i), byte(i >> 8), 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9})
	}
	tx.Commit()
	_, _, body := e.get(t, "/v1/"+resID+"/events/"+reportID+"/timeline", readToken)
	var tl struct {
		Entries   []TimelineEntry
		Truncated bool
	}
	json.Unmarshal(body, &tl)
	found := false
	for _, en := range tl.Entries {
		found = found || en.EventID == reportID
	}
	if !found || !tl.Truncated {
		t.Fatalf("anchor kept=%v truncated=%v entries=%d", found, tl.Truncated, len(tl.Entries))
	}
}

func TestPagination(t *testing.T) {
	e := newReadEnv(t)
	seen := map[string]bool{}
	path := "/v1/" + resID + "/events?limit=1"
	for i := 0; i < 10; i++ {
		_, _, body := e.get(t, path, readToken)
		var r struct {
			Events []EventRow
			Next   string
		}
		json.Unmarshal(body, &r)
		for _, ev := range r.Events {
			if seen[ev.EventID] {
				t.Fatalf("repeated %s", ev.EventID)
			}
			seen[ev.EventID] = true
		}
		if r.Next == "" {
			break
		}
		path = "/v1/" + resID + "/events?limit=1&cursor=" + r.Next
	}
	if len(seen) != 4 {
		t.Fatalf("pages covered %d events", len(seen))
	}
	for _, bad := range []string{"since=-5m", "since=99999999999d", "since=1h&until=2h", "tag=a:1&tag=b:2", "attr=a%22b:1"} {
		u := "/v1/" + resID + "/events?" + bad
		if strings.HasPrefix(bad, "attr") {
			u = "/v1/" + resID + "/logs?" + bad
		}
		if code, _, body := e.get(t, u, readToken); code != 400 {
			t.Errorf("%s: %d %s", bad, code, body)
		}
	}
	// Dashed ids resolve.
	dashed := reportID[:8] + "-" + reportID[8:12] + "-" + reportID[12:16] + "-" + reportID[16:20] + "-" + reportID[20:]
	if code, _, _ := e.get(t, "/v1/"+resID+"/events/"+strings.ToUpper(dashed), readToken); code != 200 {
		t.Fatalf("dashed id %d", code)
	}
}

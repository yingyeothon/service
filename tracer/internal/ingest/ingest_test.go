package ingest

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/addrlimit"
	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/store"
)

const testKey = "aaaaaaaaaaaaaaaaaaaa"

type countingSource struct {
	resource.Source
	n atomic.Int64
}

func (c *countingSource) Lookup(ctx context.Context, id string) (resource.Resource, error) {
	c.n.Add(1)
	return c.Source.Lookup(ctx, id)
}

func localSource(t *testing.T, dailyBytes int64) *countingSource {
	t.Helper()
	f, err := config.ParseLocal([]byte(`{"resources":[{"id":"trc_demo1","writeKey":"` + testKey + `","dailyBytes":` + itoa(dailyBytes) + `}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return &countingSource{Source: resource.NewLocal(f)}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

type fakeCapacity struct{ allow atomic.Bool }

func (f *fakeCapacity) Allow(int64) bool { return f.allow.Load() }
func (f *fakeCapacity) Add(int64)        {}

type env struct {
	srv   *httptest.Server
	h     *Handler
	st    *store.Store
	reg   *metrics.Registry
	blobs string
	src   *countingSource
	cap   *fakeCapacity
}

func newEnv(t *testing.T, mutate func(*Options)) *env {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	st, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	w := st.StartWriter(ctx)
	e := &env{st: st, reg: metrics.New(), blobs: filepath.Join(dir, "blobs"), src: localSource(t, 50<<20), cap: &fakeCapacity{}}
	e.cap.allow.Store(true)
	opt := Options{Source: e.src, Metrics: e.reg, Writer: w, Capacity: e.cap, DailyBytes: st.DailyBytes, BlobDir: e.blobs}
	if mutate != nil {
		mutate(&opt)
		if cs, ok := opt.Source.(*countingSource); ok {
			e.src = cs
		}
	}
	e.h = New(opt)
	e.srv = httptest.NewServer(e.h)
	t.Cleanup(func() { e.srv.Close(); cancel(); <-w.Done(); st.Close() })
	return e
}

var auth = map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey + ", sentry_version=7, sentry_client=yyt-dart/0.1.0"}

func (e *env) post(t *testing.T, path string, body []byte, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+path, bytes.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func (e *env) count(t *testing.T, q string, args ...any) int64 {
	t.Helper()
	e.h.FlushDrops(context.Background())
	var n int64
	if err := e.st.DB.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../../testdata/envelopes", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func with(h map[string]string, kv ...string) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i]] = kv[i+1]
	}
	return out
}

func blobFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	return out
}

const envURL = "/api/trc_demo1/envelope/"

func TestAuth(t *testing.T) {
	e := newEnv(t, nil)
	cases := []struct {
		name   string
		url    string
		header map[string]string
		want   int
	}{
		{"no key", envURL, nil, http.StatusUnauthorized},
		{"wrong key", envURL + "?sentry_key=nope", nil, http.StatusUnauthorized},
		{"unknown resource", "/api/trc_other/envelope/", auth, http.StatusUnauthorized},
		{"numeric id", "/api/7/envelope/", auth, http.StatusUnauthorized},
		{"header key", envURL, auth, http.StatusOK},
		{"query key", envURL + "?sentry_key=" + testKey, nil, http.StatusOK},
		{"subpath not routed", envURL + "x", auth, http.StatusNotFound},
	}
	for _, c := range cases {
		if res, body := e.post(t, c.url, []byte("{}\n"), c.header); res.StatusCode != c.want {
			t.Errorf("%s: status %d (%s), want %d", c.name, res.StatusCode, body, c.want)
		}
	}
}

// TestGoldenEnvelopes posts every captured envelope as its sender did
// (gzip), then again (an SDK retry): one row each, 200 both times.
func TestGoldenEnvelopes(t *testing.T) {
	e := newEnv(t, nil)
	files, _ := filepath.Glob("../../testdata/envelopes/*/*.envelope")
	for round := 0; round < 2; round++ {
		for _, f := range files {
			b, _ := os.ReadFile(f)
			res, body := e.post(t, envURL, gz(b), with(auth, "Content-Encoding", "gzip"))
			if res.StatusCode != http.StatusOK {
				t.Fatalf("%s: %d %s", f, res.StatusCode, body)
			}
		}
	}
	checks := map[string]int64{
		"SELECT count(*) FROM events WHERE type='event'":                                 6,
		"SELECT count(*) FROM events WHERE type='feedback'":                              1,
		"SELECT count(*) FROM transactions":                                              1,
		"SELECT count(*) FROM attachments":                                               8,
		"SELECT count(*) FROM sessions":                                                  1,
		"SELECT count(*) FROM logs":                                                      12,
		"SELECT count(*) FROM issues":                                                    6,
		"SELECT count FROM drops WHERE item_type='replay_video' AND reason='not_stored'": 2,
		"SELECT errors FROM sessions":                                                    1,
	}
	for q, want := range checks {
		if got := e.count(t, q); got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
	if files := blobFiles(t, e.blobs); len(files) != 8 {
		t.Fatalf("blob files %v", files)
	}
	var sum, path string
	e.st.DB.QueryRow("SELECT sha256, path FROM attachments WHERE content_type='image/png'").Scan(&sum, &path)
	if !strings.HasPrefix(path, "trc_demo1/") || len(sum) != 64 {
		t.Fatalf("attachment row %s %s", path, sum)
	}
	if e.reg.Counters.Duplicates.Load() == 0 {
		t.Fatal("duplicates not counted")
	}
	// The retry round added no attachment bytes to the day.
	var sizes int64
	e.st.DB.QueryRow("SELECT sum(size) FROM attachments").Scan(&sizes)
	if day := e.count(t, "SELECT bytes FROM daily_bytes"); day > 2*sizes+100_000 || day < sizes {
		t.Fatalf("daily bytes %d for %d attachment bytes", day, sizes)
	}
}

func TestResponseID(t *testing.T) {
	e := newEnv(t, nil)
	_, body := e.post(t, envURL, fixture(t, "sentry-android/feedback.envelope"), auth)
	var r struct{ ID string }
	json.Unmarshal([]byte(body), &r)
	if len(r.ID) != 32 {
		t.Fatalf("id %q", body)
	}
}

func TestEncodings(t *testing.T) {
	e := newEnv(t, nil)
	b := fixture(t, "sentry-dart/log.envelope")
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	zw.Write(b)
	zw.Close()
	if res, body := e.post(t, envURL, z.Bytes(), with(auth, "Content-Encoding", "deflate")); res.StatusCode != 200 {
		t.Fatalf("zlib deflate %d %s", res.StatusCode, body)
	}
	if res, _ := e.post(t, envURL, b, with(auth, "Content-Encoding", "br")); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("br %d", res.StatusCode)
	}
	if res, _ := e.post(t, envURL, []byte("not gzip"), with(auth, "Content-Encoding", "gzip")); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad gzip %d", res.StatusCode)
	}
	if res, _ := e.post(t, envURL, []byte("nope\n"), auth); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed %d", res.StatusCode)
	}
	if res, _ := e.post(t, envURL, []byte("{}\n{\"type\":\"attachment\",\"length\":99}\nabc"), auth); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("truncated %d", res.StatusCode)
	}
	if files := blobFiles(t, e.blobs); len(files) != 0 {
		t.Fatalf("truncated attachment left %v", files)
	}
}

func TestSizeCaps(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.MaxBodyBytes = 4 << 10; o.MaxDecompressed = 8 << 10; o.MaxJSONItem = 1 << 10 })
	big := append([]byte("{}\n{\"type\":\"attachment\",\"length\":6000}\n"), bytes.Repeat([]byte("x"), 6000)...)
	if res, _ := e.post(t, envURL, big, auth); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("compressed cap %d", res.StatusCode)
	}
	bomb := append([]byte("{}\n{\"type\":\"attachment\",\"length\":20000}\n"), bytes.Repeat([]byte("x"), 20000)...)
	if res, _ := e.post(t, envURL, gz(bomb), with(auth, "Content-Encoding", "gzip")); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("decompressed cap %d", res.StatusCode)
	}
	if n := e.count(t, "SELECT count FROM drops WHERE reason='too_large'"); n != 2 {
		t.Fatalf("too_large drops %d", n)
	}
	if files := blobFiles(t, e.blobs); len(files) != 0 {
		t.Fatalf("refused envelope left %v", files)
	}
	// A JSON item over its cap is dropped, the rest of the envelope stored.
	item := `{"event_id":"0123456789abcdef0123456789abcdef","message":"` + strings.Repeat("y", 2000) + `"}`
	env := "{}\n{\"type\":\"event\",\"length\":" + itoa(int64(len(item))) + "}\n" + item + "\n{\"type\":\"session\"}\n{\"sid\":\"s\"}\n"
	if res, _ := e.post(t, envURL, []byte(env), auth); res.StatusCode != 200 {
		t.Fatalf("item cap %d", res.StatusCode)
	}
	if e.count(t, "SELECT count(*) FROM events") != 0 || e.count(t, "SELECT count(*) FROM sessions") != 1 {
		t.Fatal("oversized item stored or neighbour lost")
	}
}

func TestUnknownAndInvalidItems(t *testing.T) {
	e := newEnv(t, nil)
	body := "{}\n{\"type\":\"future_thing\",\"length\":3}\nabc\n{\"type\":\"client_report\"}\n{}\n{\"type\":\"event\"}\n{\"no\":\"id\"}\n"
	if res, _ := e.post(t, envURL, []byte(body), auth); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	for reason, want := range map[string]int64{"unknown": 1, "not_stored": 1, "invalid": 1} {
		if got := e.count(t, "SELECT coalesce(sum(count),0) FROM drops WHERE reason=?", reason); got != want {
			t.Errorf("%s: %d", reason, got)
		}
	}
}

func TestLegacyStore(t *testing.T) {
	e := newEnv(t, nil)
	ev := `{"event_id":"0123456789abcdef0123456789abcdef","message":"legacy","level":"error"}`
	if res, body := e.post(t, "/api/trc_demo1/store/", []byte(ev), auth); res.StatusCode != 200 || !strings.Contains(body, "0123456789abcdef0123456789abcdef") {
		t.Fatalf("legacy %d %s", res.StatusCode, body)
	}
}

func TestQuotaStages(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *Options) { o.Source = localSource(t, 10_000); o.Now = func() time.Time { return now } })
	// ~46 KB: the first envelope of the day is under quota when it starts.
	if res, _ := e.post(t, envURL, fixture(t, "sentry-android/event-screenshot-view-hierarchy.envelope"), auth); res.StatusCode != 200 {
		t.Fatalf("first %d", res.StatusCode)
	}
	if e.count(t, "SELECT count(*) FROM attachments") != 2 {
		t.Fatal("under quota attachments must be stored")
	}
	if e.count(t, "SELECT count(*) FROM daily_bytes WHERE quota_hit_ms IS NOT NULL") != 1 {
		t.Fatal("first crossing not recorded")
	}
	res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth)
	if res.StatusCode != http.StatusTooManyRequests || res.Header.Get("Retry-After") != "300" {
		t.Fatalf("over 120%%: %d %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
	if e.count(t, "SELECT count FROM drops WHERE reason='quota_refused'") != 1 || e.count(t, "SELECT count(*) FROM logs") != 0 {
		t.Fatal("quota_refused not counted or log stored")
	}
	now = now.Add(24 * time.Hour) // next UTC day: counters reset
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != 200 {
		t.Fatalf("next day %d", res.StatusCode)
	}
}

func TestQuotaDropsAttachmentsBetween100And120(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Source = localSource(t, 100_000)
		o.DailyBytes = func(context.Context, string, string) (int64, bool, error) { return 105_000, true, nil }
	})
	if res, _ := e.post(t, envURL, fixture(t, "sentry-android/event-screenshot-view-hierarchy.envelope"), auth); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.count(t, "SELECT count(*) FROM attachments") != 0 || e.count(t, "SELECT count(*) FROM events") != 1 {
		t.Fatal("attachments must drop, the event must stay")
	}
	if e.count(t, "SELECT count FROM drops WHERE reason='quota_attachment'") != 2 {
		t.Fatal("quota_attachment drops")
	}
	if n := e.count(t, "SELECT bytes FROM daily_bytes"); n > 20_000 {
		t.Fatalf("dropped attachment bytes charged to the quota: %d", n)
	}
}

func TestCapacityRefuses(t *testing.T) {
	e := newEnv(t, nil)
	e.cap.allow.Store(false)
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.count(t, "SELECT count FROM drops WHERE reason='disk'") != 1 {
		t.Fatal("disk refusal not counted")
	}
}

func TestInFlightBound(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.InFlight = 1; o.InFlightWait = 50 * time.Millisecond })
	e.h.sem <- struct{}{} // one envelope in flight
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d", res.StatusCode)
	}
	<-e.h.sem
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != 200 {
		t.Fatalf("after release %d", res.StatusCode)
	}
}

func TestFailureBucketSkipsLookups(t *testing.T) {
	e := newEnv(t, nil)
	for i := 0; i < addrlimit.Burst+10; i++ {
		e.post(t, envURL+"?sentry_key=wrong", []byte("{}\n"), nil)
	}
	if n := e.src.n.Load(); n > addrlimit.Burst+1 {
		t.Fatalf("lookups after the bucket emptied: %d", n)
	}
	// A correct key from the same (NATed) address is told to back off, not that its key is wrong.
	res, _ := e.post(t, envURL, []byte("{}\n"), auth)
	if res.StatusCode != http.StatusServiceUnavailable || res.Header.Get("Retry-After") == "" {
		t.Fatalf("exhausted bucket: %d %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
}

func TestPerEnvelopeBounds(t *testing.T) {
	e := newEnv(t, nil)
	var b strings.Builder
	b.WriteString("{\"event_id\":\"0123456789abcdef0123456789abcdef\"}\n")
	for i := 0; i < 5000; i++ {
		b.WriteString("{\"type\":\"attachment\",\"length\":0}\n\n")
	}
	for i := 0; i < 50; i++ {
		b.WriteString("{\"type\":\"event\"}\n{}\n")
	}
	for i := 0; i < 300; i++ {
		b.WriteString("{\"type\":\"z" + itoa(int64(i)) + "\"}\nx\n")
	}
	if res, body := e.post(t, envURL, []byte(b.String()), auth); res.StatusCode != 200 {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	if n := e.count(t, "SELECT count(*) FROM attachments"); n > MaxAttachmentsPerEnvelope {
		t.Fatalf("attachments %d", n)
	}
	if n := len(blobFiles(t, e.blobs)); n > MaxAttachmentsPerEnvelope {
		t.Fatalf("blob files %d", n)
	}
	if n := e.count(t, "SELECT count(*) FROM events"); n > 1 {
		t.Fatalf("events %d (same header id dedupes)", n)
	}
	if n := e.count(t, "SELECT count(*) FROM drops WHERE reason='unknown'"); n != 0 {
		t.Fatalf("unknown types beyond the item cap still counted: %d", n)
	}
	if n := e.count(t, "SELECT count(DISTINCT item_type) FROM drops"); n > 4 {
		t.Fatalf("drop item types %d", n)
	}
	// Unknown types share one label.
	if res, _ := e.post(t, envURL, []byte("{}\n{\"type\":\"a1\"}\nx\n{\"type\":\"a2\"}\ny\n"), auth); res.StatusCode != 200 {
		t.Fatal("unknown types")
	}
	if n := e.count(t, "SELECT count FROM drops WHERE item_type='unknown' AND reason='unknown'"); n != 2 {
		t.Fatalf("unknown label %d", n)
	}
}

func TestOversizedLineItemKeepsTheRest(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.MaxJSONItem = 1 << 10 })
	body := "{}\n{\"type\":\"event\"}\n{\"event_id\":\"0123456789abcdef0123456789abcdef\",\"message\":\"" + strings.Repeat("y", 2000) + "\"}\n{\"type\":\"session\"}\n{\"sid\":\"s\"}\n"
	if res, _ := e.post(t, envURL, []byte(body), auth); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.count(t, "SELECT count(*) FROM sessions") != 1 || e.count(t, "SELECT count FROM drops WHERE reason='too_large'") != 1 {
		t.Fatal("oversized line item must drop alone")
	}
}

func TestEmptyGzipIs400(t *testing.T) {
	e := newEnv(t, nil)
	if res, _ := e.post(t, envURL, nil, with(auth, "Content-Encoding", "gzip")); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.count(t, "SELECT count FROM drops WHERE item_type='envelope' AND reason='invalid'") != 1 {
		t.Fatal("400 not counted")
	}
}

func TestDroppedLogsCounted(t *testing.T) {
	e := newEnv(t, nil)
	var items []string
	for i := 0; i < 1005; i++ {
		items = append(items, `{"timestamp":`+itoa(int64(i))+`,"body":"x"}`)
	}
	p := `{"items":[` + strings.Join(items, ",") + `]}`
	body := "{}\n{\"type\":\"log\",\"length\":" + itoa(int64(len(p))) + "}\n" + p + "\n"
	if res, _ := e.post(t, envURL, []byte(body), auth); res.StatusCode != 200 {
		t.Fatal("status")
	}
	if e.count(t, "SELECT count(*) FROM logs") != 1000 || e.count(t, "SELECT count FROM drops WHERE item_type='log' AND reason='too_large'") != 5 {
		t.Fatal("dropped log entries not counted")
	}
}

func TestPerAddressSlots(t *testing.T) {
	e := newEnv(t, nil)
	e.h.perAddr.acquire("127.0.0.1")
	e.h.perAddr.acquire("127.0.0.1")
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third slot for one address: %d", res.StatusCode)
	}
	e.h.perAddr.release("127.0.0.1")
	if res, _ := e.post(t, envURL, fixture(t, "sentry-dart/log.envelope"), auth); res.StatusCode != 200 {
		t.Fatalf("after release: %d", res.StatusCode)
	}
}

type failingSource struct{}

func (failingSource) Lookup(context.Context, string) (resource.Resource, error) {
	return resource.Resource{}, errors.New("console down")
}

func TestSourceFailureIs503(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Source = failingSource{} })
	if res, _ := e.post(t, envURL+"?sentry_key=x", nil, nil); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d", res.StatusCode)
	}
	// Made-up ids during an outage spend the address budget and never
	// become per-resource buckets.
	for i := 0; i < addrlimit.Burst+5; i++ {
		e.post(t, "/api/trc_made"+itoa(int64(i))+"/envelope/", nil, auth)
	}
	if !strings.Contains(string(mustJSON(t, e.reg.Detailed())), "trc_made") {
		return
	}
	t.Fatal("unconfirmed ids got per-resource metrics")
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDropCounterBounded(t *testing.T) {
	d := &dropCounter{m: map[dropKey]int64{}}
	for i := 0; i < maxDropKeys+100; i++ {
		d.add(dropKey{resource: "trc_x" + itoa(int64(i)), reason: "console"}, 0, false)
	}
	if len(d.take()) != maxDropKeys {
		t.Fatal("drop counter not bounded")
	}
}

func TestDumpScrubsCredentials(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(o *Options) { o.DumpDir = dir; o.MaxBodyBytes = 64 })
	h := with(auth, "X-Sentry-Auth", "Sentry sentry_key="+testKey+", sentry_version=7, sentry_client=sentry.java.android.flutter/8.0.0", "Content-Encoding", "gzip")
	if res, _ := e.post(t, envURL+"?sentry_key="+testKey, []byte("{\"event_id\":\"x\"}\n"), h); res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	lower := map[string]string{"X-Sentry-Auth": "sentry sentry_key=" + testKey + ",sentry_secret=s3cret", "Proxy-Authorization": "Basic " + testKey}
	if res, _ := e.post(t, envURL, []byte("{}\n"), lower); res.StatusCode != http.StatusOK {
		t.Fatalf("lowercase scheme: status %d", res.StatusCode)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(files) != 4 {
		t.Fatalf("dump files %v", files)
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), testKey) || strings.Contains(string(b), "s3cret") {
			t.Errorf("%s contains a credential: %s", filepath.Base(f), b)
		}
	}
	if res, _ := e.post(t, envURL+"?sentry_key="+testKey, []byte(strings.Repeat("x", 65)), nil); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize dump: status %d", res.StatusCode)
	}
}

func TestSentryKeyForms(t *testing.T) {
	for header, want := range map[string]string{
		"Sentry sentry_key=abc, sentry_version=7": "abc",
		"sentry sentry_version=7,sentry_key=def":  "def",
		"Sentry sentry_version=7":                 "",
		"SENTRY\tsentry_key=ghi":                  "ghi",
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Header.Set("X-Sentry-Auth", header)
		if got := SentryKey(r); got != want {
			t.Errorf("%q: %q, want %q", header, got, want)
		}
	}
}

// rawPost opens a connection, sends the request line, headers and the first
// `send` bytes of body (declaring the full length), then stalls.
func rawPost(t *testing.T, e *env, body []byte, send int) *bufio.Reader {
	t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: x\r\nX-Sentry-Auth: %s\r\nContent-Length: %d\r\n\r\n", envURL, auth["X-Sentry-Auth"], len(body))
	if _, err := c.Write(body[:send]); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	return bufio.NewReader(c)
}

func rawStatus(t *testing.T, br *bufio.Reader) int {
	t.Helper()
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// waitAddrSlots waits until the address holds n per-address slots.
func waitAddrSlots(t *testing.T, e *env, n int) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		e.h.perAddr.mu.Lock()
		got := e.h.perAddr.m["127.0.0.1"]
		e.h.perAddr.mu.Unlock()
		if got >= n {
			return
		}
	}
	t.Fatalf("address never held %d slots", n)
}

// attachmentEnvelope is an envelope of one attachment of n bytes.
func attachmentEnvelope(n int) []byte {
	b := []byte(fmt.Sprintf("{}\n{\"type\":\"attachment\",\"length\":%d,\"filename\":\"a.bin\"}\n", n))
	return append(b, bytes.Repeat([]byte("x"), n)...)
}

func TestStalledBodyNeverTakesASlot(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.InFlight = 1
		o.InFlightWait = 50 * time.Millisecond // shorter than the stall: a held slot shows as 503
		o.BodyFirstByteWait = 2 * time.Second
	})
	body := fixture(t, "sentry-dart/log.envelope")
	br := rawPost(t, e, body, 0) // headers only, then nothing
	waitAddrSlots(t, e, 1)
	if g := e.reg.Gauges.InFlight.Load(); g != 0 {
		t.Fatalf("a stalled client holds %d shared slots", g)
	}
	if res, _ := e.post(t, envURL, body, auth); res.StatusCode != 200 {
		t.Fatalf("a stalled client held the only slot: %d", res.StatusCode)
	}
	if s := rawStatus(t, br); s != http.StatusServiceUnavailable {
		t.Fatalf("stalled body: %d", s)
	}
	if e.reg.Counters.StoreErrors.Load() != 0 {
		t.Fatal("a stalled client counted as a store error")
	}
}

func TestSlowBodyLosesItsSlot(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.InFlight = 1
		o.InFlightWait = 50 * time.Millisecond
		o.BodyGrace = time.Second
		o.BodyMinRate = 1 << 20
	})
	body := fixture(t, "sentry-dart/log.envelope")
	br := rawPost(t, e, body, 10) // a few bytes, then a stall
	for deadline := time.Now().Add(3 * time.Second); e.reg.Gauges.InFlight.Load() == 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the slow client never took the slot")
		}
	}
	if res, _ := e.post(t, envURL, body, auth); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("slot should be held within grace: %d", res.StatusCode)
	}
	start := time.Now()
	if s := rawStatus(t, br); s != http.StatusServiceUnavailable {
		t.Fatalf("slow body: %d", s)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("slot held %v", time.Since(start))
	}
	if res, _ := e.post(t, envURL, body, auth); res.StatusCode != 200 {
		t.Fatalf("slot not released: %d", res.StatusCode)
	}
	if e.reg.Counters.StoreErrors.Load() != 0 {
		t.Fatal("a slow client counted as a store error")
	}
}

// trickle sends body in chunk-byte writes every gap, then returns the status.
func trickle(t *testing.T, e *env, body []byte, chunk int, gap time.Duration) int {
	t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: x\r\nX-Sentry-Auth: %s\r\nContent-Length: %d\r\n\r\n", envURL, auth["X-Sentry-Auth"], len(body))
	for off := 0; off < len(body); off += chunk {
		if _, err := c.Write(body[off:min(off+chunk, len(body))]); err != nil {
			break // the server answered and closed early
		}
		time.Sleep(gap)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	return rawStatus(t, bufio.NewReader(c))
}

func TestSteadyBodyAboveMinRateKeepsItsSlot(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.BodyGrace = 200 * time.Millisecond; o.BodyMinRate = 4096 })
	// ~6.4 KiB/s for ~650 ms: past the grace, above the minimum rate.
	if s := trickle(t, e, attachmentEnvelope(4000), 64, 10*time.Millisecond); s != 200 {
		t.Fatalf("steady body: %d", s)
	}
}

func TestBodyMaxWaitCaps(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.BodyGrace = 10 * time.Second
		o.BodyMaxWait = 300 * time.Millisecond
	})
	start := time.Now()
	if s := trickle(t, e, attachmentEnvelope(4000), 64, 10*time.Millisecond); s != http.StatusServiceUnavailable {
		t.Fatalf("over the max wait: %d", s)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("max wait not applied: %v", time.Since(start))
	}
}

func TestSlowGzipBodyIsSlowNotInvalid(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.BodyGrace = 200 * time.Millisecond; o.BodyMinRate = 1 << 20 })
	body := gz(attachmentEnvelope(4000))
	c, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: x\r\nX-Sentry-Auth: %s\r\nContent-Encoding: gzip\r\nContent-Length: %d\r\n\r\n", envURL, auth["X-Sentry-Auth"], len(body))
	_, _ = c.Write(body[:20])
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if s := rawStatus(t, bufio.NewReader(c)); s != http.StatusServiceUnavailable {
		t.Fatalf("slow gzip body: %d", s)
	}
}

func TestEmptyBodyDoesNotWaitForFirstByte(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.BodyFirstByteWait = 3 * time.Second })
	start := time.Now()
	if res, _ := e.post(t, envURL, nil, auth); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty body: %d", res.StatusCode)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("empty body waited %v", time.Since(start))
	}
}

type slowWriter struct {
	w     Writer
	delay time.Duration
}

func (s slowWriter) Write(ctx context.Context, b *store.Batch) (store.Result, error) {
	time.Sleep(s.delay)
	return s.w.Write(ctx, b)
}

// A store write that outlasts the pacing grace after the body's EOF must not
// be cancelled (the deadline is never re-armed after EOF).
func TestSlowStoreAfterBodyEOFIsNotCancelled(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.BodyGrace = 100 * time.Millisecond
		o.Writer = slowWriter{w: o.Writer, delay: 400 * time.Millisecond}
	})
	res, body := e.post(t, envURL, fixture(t, "yyt-dart/report.envelope"), auth)
	if res.StatusCode != 200 || !strings.Contains(body, `"id":"1011`) {
		t.Fatalf("status %d body %q", res.StatusCode, body)
	}
}

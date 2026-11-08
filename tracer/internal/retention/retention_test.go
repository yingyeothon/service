package retention

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/store"
)

type env struct {
	st    *store.Store
	w     *store.Writer
	dir   string
	blobs string
	now   time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	st, err := store.Open(ctx, filepath.Join(dir, "tracer.db"))
	if err != nil {
		t.Fatal(err)
	}
	w := st.StartWriter(ctx)
	t.Cleanup(func() { cancel(); <-w.Done(); st.Close() })
	return &env{st: st, w: w, dir: dir, blobs: filepath.Join(dir, "blobs"), now: time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)}
}

func (e *env) ret(stage int64) *Retention {
	return New(Options{DB: e.st.DB, DBPath: filepath.Join(e.dir, "tracer.db"), BlobDir: e.blobs, StageBytes: stage,
		Now: func() time.Time { return e.now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

// put writes an event (group g) with an attachment file, received at `at`.
func (e *env) put(t *testing.T, id, group string, at time.Time, size int) string {
	t.Helper()
	blobID := "b" + id
	rel := filepath.Join("trc_a", at.Format("2006-01-02"), blobID)
	abs := filepath.Join(e.blobs, rel)
	os.MkdirAll(filepath.Dir(abs), 0o700)
	os.WriteFile(abs, make([]byte, size), 0o600)
	old := at.Add(-2 * time.Hour)
	os.Chtimes(abs, old, old)
	_, err := e.w.Write(context.Background(), &store.Batch{ResourceID: "trc_a", Day: at.Format("2006-01-02"), ReceivedMs: at.UnixMilli(),
		Events:      []store.Event{{EventID: id, Type: "event", TsMs: at.UnixMilli(), GroupKey: group, JSON: []byte("{}"), Breadcrumbs: []store.Breadcrumb{{Message: "m"}}}},
		Logs:        []store.Log{{TsMs: at.UnixMilli(), Body: "l", DedupeKey: []byte(id + "0123456789abcdef")[:16]}},
		Attachments: []store.Attachment{{EventID: id, BlobID: blobID, Path: rel, Size: int64(size), SHA256: id}},
		Bytes:       int64(size)})
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func (e *env) count(t *testing.T, q string) int64 {
	t.Helper()
	var n int64
	if err := e.st.DB.QueryRow(q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAgePass(t *testing.T) {
	e := newEnv(t)
	oldFile := e.put(t, "e_old", "g1", e.now.Add(-32*24*time.Hour), 100)
	newFile := e.put(t, "e_new", "g1", e.now.Add(-time.Hour), 100)
	e.put(t, "e_gone", "g2", e.now.Add(-40*24*time.Hour), 100)
	rep, err := e.ret(0).Once(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if e.count(t, "SELECT count(*) FROM events") != 1 || e.count(t, "SELECT count(*) FROM logs") != 1 || e.count(t, "SELECT count(*) FROM breadcrumbs") != 1 {
		t.Fatalf("rows left: %+v", rep)
	}
	if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
		t.Fatal("old blob kept")
	}
	if _, err := os.Stat(newFile); err != nil {
		t.Fatal("new blob removed")
	}
	if e.count(t, "SELECT count(*) FROM issues") != 1 || e.count(t, "SELECT count FROM issues") != 1 || rep.IssuesGone != 1 {
		t.Fatalf("issues not refreshed: %+v", rep)
	}
	if e.count(t, "SELECT count(*) FROM daily_bytes") != 1 {
		t.Fatal("old daily counters kept")
	}
}

func TestCapPassDeletesOldestFirst(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 10; i++ {
		e.put(t, "e"+string(rune('a'+i)), "g", e.now.Add(-time.Duration(10-i)*2*time.Hour), 200_000)
	}
	r := e.ret(1_000_000) // 2 MB of blobs against a 1 MB cap
	rep, err := r.Once(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rep.BytesAfter > 900_000 || rep.CapRows == 0 {
		t.Fatalf("still over: %+v", rep)
	}
	var newest string
	e.st.DB.QueryRow("SELECT event_id FROM events ORDER BY received_ms DESC LIMIT 1").Scan(&newest)
	if newest != "ej" {
		t.Fatalf("newest data deleted: %s", newest)
	}
	if e.count(t, "SELECT count(*) FROM events WHERE event_id = 'ea'") != 0 {
		t.Fatal("oldest kept")
	}
}

func TestOrphanSweep(t *testing.T) {
	e := newEnv(t)
	kept := e.put(t, "e1", "g", e.now.Add(-time.Hour), 10)
	orphan := filepath.Join(e.blobs, "trc_a", "2026-12-30", "deadbeef")
	os.WriteFile(orphan, []byte("x"), 0o600)
	tmp := filepath.Join(e.blobs, "trc_a", "2026-12-30", ".tmp-x")
	os.WriteFile(tmp, []byte("x"), 0o600)
	fresh := filepath.Join(e.blobs, "trc_a", "2026-12-30", "fresh")
	os.WriteFile(fresh, []byte("x"), 0o600)
	old := e.now.Add(-2 * time.Hour)
	os.Chtimes(orphan, old, old)
	os.Chtimes(tmp, old, old)
	os.Chtimes(fresh, e.now, e.now) // within the grace: may be an envelope in flight
	rep, err := e.ret(0).Once(context.Background())
	if err != nil || rep.Orphans != 2 {
		t.Fatalf("%+v %v", rep, err)
	}
	for p, want := range map[string]bool{kept: true, orphan: false, tmp: false, fresh: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists=%v", filepath.Base(p), err == nil)
		}
	}
}

func TestBlobPathStaysUnderRoot(t *testing.T) {
	r := New(Options{BlobDir: "/data/blobs"})
	if got := r.blobPath("../../etc/passwd"); got != "/data/blobs/etc/passwd" {
		t.Fatalf("%s", got)
	}
}

// A clock jumped a year ahead must not age out data received recently.
func TestClockJumpKeepsData(t *testing.T) {
	e := newEnv(t)
	e.put(t, "e1", "g", e.now.Add(-time.Hour), 10)
	e.now = e.now.Add(365 * 24 * time.Hour)
	if _, err := e.ret(0).Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.count(t, "SELECT count(*) FROM events") != 1 {
		t.Fatal("a forward clock jump deleted fresh data")
	}
}

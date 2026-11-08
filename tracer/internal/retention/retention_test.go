package retention

import (
	"context"
	"errors"
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

func TestPurgeDeletedResources(t *testing.T) {
	e := newEnv(t)
	file := e.put(t, "e1", "g1", e.now.Add(-time.Hour), 100)
	day := e.now.Format("2006-01-02")
	at := e.now.Add(-time.Hour).UnixMilli()
	extra := func(res string) {
		t.Helper()
		if _, err := e.w.Write(context.Background(), &store.Batch{ResourceID: res, Day: day, ReceivedMs: at, Bytes: 10,
			Events:       []store.Event{{EventID: "x_" + res, Type: "event", TsMs: at, GroupKey: "g9", JSON: []byte("{}"), Tags: [][2]string{{"k", "v"}}}},
			Transactions: []store.Transaction{{EventID: "t_" + res, Name: "n", StartMs: at, EndMs: at + 1}},
			Sessions:     []store.Session{{SID: "s_" + res, Status: "ok", UpdatedMs: at}}}); err != nil {
			t.Fatal(err)
		}
	}
	extra("trc_a")
	extra("trc_b") // another resource: must survive the purge
	if err := e.w.RecordDrops(context.Background(), "trc_a", day, store.Drop{ItemType: "attachment", Reason: "quota_attachment", Count: 1}); err != nil {
		t.Fatal(err)
	}
	var purged []string
	opt := func(list []string, err error) *Retention {
		r := e.ret(0)
		r.opt.Deleted = func(context.Context) ([]string, error) { return list, err }
		r.opt.Purged = func(id string) { purged = append(purged, id) }
		return r
	}
	// A failed list purges nothing and does not fail the pass.
	if _, err := opt(nil, errors.New("down")).Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.count(t, "SELECT count(*) FROM events") != 3 {
		t.Fatal("purged on a failed list")
	}
	// Another id leaves trc_a alone.
	if _, err := opt([]string{"trc_other"}, nil).Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.count(t, "SELECT count(*) FROM events") != 3 {
		t.Fatal("purged the wrong resource")
	}
	rep, err := opt([]string{"trc_a"}, nil).Once(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"events", "breadcrumbs", "logs", "attachments", "issues", "drops", "daily_bytes", "event_tags", "transactions", "sessions"} {
		if n := e.count(t, "SELECT count(*) FROM "+table+" WHERE resource_id = 'trc_a'"); n != 0 {
			t.Errorf("%s keeps %d rows", table, n)
		}
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("blob file kept")
	}
	if rep.PurgedResources != 1 || rep.PurgedRows == 0 || rep.BlobsRemoved != 1 {
		t.Fatalf("report %+v", rep)
	}
	if len(purged) != 2 || purged[1] != "trc_a" {
		t.Fatalf("purged callback %v", purged)
	}
	for _, table := range []string{"events", "event_tags", "transactions", "sessions", "issues", "daily_bytes"} {
		if n := e.count(t, "SELECT count(*) FROM "+table+" WHERE resource_id = 'trc_b'"); n == 0 {
			t.Errorf("%s lost trc_b", table)
		}
	}
	// A purged id is not purged again by the same Retention.
	r := opt([]string{"trc_a"}, nil)
	r.purged["trc_a"] = true
	if rep, _ := r.Once(context.Background()); rep.PurgedRows != 0 || len(purged) != 2 {
		t.Fatalf("repeat purge %+v", rep)
	}
}

func TestPurgeFailureDoesNotStopRetention(t *testing.T) {
	e := newEnv(t)
	e.put(t, "e_new", "g1", e.now.Add(-time.Hour), 100) // trc_a, today: its purge will fail
	old := e.now.Add(-40 * 24 * time.Hour)
	if _, err := e.w.Write(context.Background(), &store.Batch{ResourceID: "trc_b", Day: old.Format("2006-01-02"), ReceivedMs: old.UnixMilli(),
		Events: []store.Event{{EventID: "b_old", Type: "event", TsMs: old.UnixMilli(), JSON: []byte("{}")}}}); err != nil {
		t.Fatal(err)
	}
	r := e.ret(0)
	r.opt.Deleted = func(context.Context) ([]string, error) { return []string{"trc_a"}, nil }
	if _, err := e.st.DB.Exec(`CREATE TRIGGER no_purge BEFORE DELETE ON daily_bytes
		WHEN OLD.resource_id = 'trc_a' BEGIN SELECT RAISE(ABORT, 'locked'); END`); err != nil {
		t.Fatal(err)
	}
	rep, err := r.Once(context.Background())
	if err != nil || rep.PurgeErr == nil {
		t.Fatalf("err %v purgeErr %v", err, rep.PurgeErr)
	}
	if e.count(t, "SELECT count(*) FROM events WHERE resource_id = 'trc_b'") != 0 {
		t.Fatal("age pass did not run after a failed purge")
	}
}

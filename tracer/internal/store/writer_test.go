package store

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func openTest(t *testing.T) (*Store, *Writer) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Open(ctx, filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	w := s.StartWriter(ctx)
	t.Cleanup(func() { cancel(); <-w.Done(); s.Close() })
	return s, w
}

func count(t *testing.T, s *Store, q string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := s.DB.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func eventBatch(id string, ts int64) *Batch {
	return &Batch{ResourceID: "trc_a", Day: "2026-11-08", ReceivedMs: ts, Bytes: 100,
		Events: []Event{{EventID: id, Type: "event", TsMs: ts, Level: "error", GroupKey: "g1", Title: "T " + id, JSON: []byte("{}"),
			Tags: [][2]string{{"k", "v"}}, Breadcrumbs: []Breadcrumb{{TsMs: ts - 1, Category: "c", Message: "m"}}}}}
}

func TestWriteDedupesAndGroups(t *testing.T) {
	s, w := openTest(t)
	ctx := context.Background()
	if _, err := w.Write(ctx, eventBatch("e1", 1000)); err != nil {
		t.Fatal(err)
	}
	res, err := w.Write(ctx, eventBatch("e1", 1000))
	if err != nil || res.DuplicateEvents != 1 {
		t.Fatalf("dup: %+v %v", res, err)
	}
	if _, err := w.Write(ctx, eventBatch("e2", 500)); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, "SELECT count(*) FROM events"); n != 2 {
		t.Fatalf("events %d", n)
	}
	if n := count(t, s, "SELECT count(*) FROM breadcrumbs"); n != 2 {
		t.Fatalf("breadcrumbs %d (duplicate must add none)", n)
	}
	var c, first, last int64
	var latest string
	s.DB.QueryRow("SELECT count, first_seen_ms, last_seen_ms, latest_event_id FROM issues").Scan(&c, &first, &last, &latest)
	if c != 2 || first != 500 || last != 1000 || latest != "e1" {
		t.Fatalf("issue %d %d %d %s", c, first, last, latest)
	}
	if b, _, _ := s.DailyBytes(ctx, "trc_a", "2026-11-08"); b != 300 {
		t.Fatalf("daily bytes %d", b)
	}
}

func TestLogsAndAttachmentsDedupe(t *testing.T) {
	s, w := openTest(t)
	ctx := context.Background()
	dir := t.TempDir()
	mk := func(name string) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte("png"), 0o600)
		return p
	}
	b := func(blob string) *Batch {
		return &Batch{ResourceID: "trc_a", Day: "d", ReceivedMs: 1,
			Logs:        []Log{{TsMs: 1, Body: "x", DedupeKey: []byte("0123456789abcdef")}},
			Attachments: []Attachment{{EventID: "e1", BlobID: blob, Path: "p/" + blob, AbsPath: mk(blob), Size: 3, SHA256: "h"}}}
	}
	if _, err := w.Write(ctx, b("b1")); err != nil {
		t.Fatal(err)
	}
	res, err := w.Write(ctx, b("b2"))
	if err != nil || res.RemovedBlobs != 1 {
		t.Fatalf("dup attachment: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "b2")); !os.IsNotExist(err) {
		t.Fatal("duplicate blob file kept")
	}
	if _, err := os.Stat(filepath.Join(dir, "b1")); err != nil {
		t.Fatal("first blob removed")
	}
	if n := count(t, s, "SELECT count(*) FROM logs"); n != 1 {
		t.Fatalf("logs %d", n)
	}
	if n := count(t, s, "SELECT count(*) FROM attachments"); n != 1 {
		t.Fatalf("attachments %d", n)
	}
}

func TestSessionMerge(t *testing.T) {
	s, w := openTest(t)
	ctx := context.Background()
	put := func(sess Session) {
		if _, err := w.Write(ctx, &Batch{ResourceID: "trc_a", Day: "d", ReceivedMs: 5, Sessions: []Session{sess}}); err != nil {
			t.Fatal(err)
		}
	}
	status := func() (st string, errs int64, did string) {
		s.DB.QueryRow("SELECT status, errors, coalesce(did,'') FROM sessions WHERE sid='s1'").Scan(&st, &errs, &did)
		return
	}
	put(Session{SID: "s1", DID: "d1", Status: "ok", UpdatedMs: 100, StartedMs: 100})
	put(Session{SID: "s1", Status: "ok", Seq: 200, Errors: 1, UpdatedMs: 200})
	put(Session{SID: "s1", Status: "crashed", Seq: 150, UpdatedMs: 150})       // clock went back: terminal still wins
	put(Session{SID: "s1", Status: "ok", Seq: 300, UpdatedMs: 300})            // late ok never undoes a crash
	put(Session{SID: "s1", Status: "ok", Seq: 200, Errors: 1, UpdatedMs: 200}) // retry
	if st, errs, did := status(); st != "crashed" || errs != 1 || did != "d1" {
		t.Fatalf("merged %s %d %s", st, errs, did)
	}
	if n := count(t, s, "SELECT count(*) FROM sessions"); n != 1 {
		t.Fatalf("rows %d", n)
	}
}

func TestConcurrentWritesAndDrops(t *testing.T) {
	s, w := openTest(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := string(rune('a'+i%26)) + string(rune('A'+i/26))
			if _, err := w.Write(ctx, eventBatch(id, int64(i))); err != nil {
				t.Error(err)
			}
			w.RecordDrops(ctx, "trc_a", "2026-11-08", Drop{ItemType: "client_report", Reason: ReasonNotStored, Count: 1, Bytes: 10})
		}(i)
	}
	wg.Wait()
	if n := count(t, s, "SELECT count(*) FROM events"); n != 40 {
		t.Fatalf("events %d", n)
	}
	if n := count(t, s, "SELECT count FROM drops WHERE reason='not_stored'"); n != 40 {
		t.Fatalf("drops %d", n)
	}
}

func TestWriterClosed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Open(ctx, filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w := s.StartWriter(ctx)
	cancel()
	<-w.Done()
	if _, err := w.Write(context.Background(), eventBatch("e", 1)); err != ErrClosed {
		t.Fatalf("after close: %v", err)
	}
}

// A full group of large envelopes commits well under the /livez deadline.
func TestGroupCommitTime(t *testing.T) {
	s, w := openTest(t)
	_ = s
	ctx := context.Background()
	mk := func(i int) *Batch {
		b := &Batch{ResourceID: "trc_a", Day: "d", ReceivedMs: 1}
		for j := 0; j < 500; j++ {
			key := []byte{byte(i), byte(j), byte(j >> 8), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13}
			b.Logs = append(b.Logs, Log{TsMs: int64(j), Body: "log line with some text", AttributesJSON: []byte(`{"k":{"value":"v","type":"string"}}`), DedupeKey: key})
		}
		return b
	}
	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); w.Write(ctx, mk(i)) }(i)
	}
	wg.Wait()
	_ = start
	// One transaction (up to 4000 rows) must stay under the 2 s /livez
	// deadline with room to spare, even under -race.
	if d := time.Duration(w.MaxTxMicros()) * time.Microsecond; d > raceSlowdown*500*time.Millisecond {
		t.Fatalf("longest transaction %s", d)
	}
}

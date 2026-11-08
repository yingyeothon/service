package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "t.db")

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"envelopes", "events", "breadcrumbs", "logs", "attachments", "drops"} {
		var n int
		if err := s.DB.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&n); err != nil || n != 1 {
			t.Errorf("table %s: n=%d err=%v", table, n, err)
		}
	}
	var mode string
	if err := s.DB.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, %v", mode, err)
	}
	var av int
	if err := s.DB.QueryRowContext(ctx, "PRAGMA auto_vacuum").Scan(&av); err != nil || av != 2 {
		t.Errorf("auto_vacuum = %d (want 2 = incremental), %v", av, err)
	}
	s.Close()

	s, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	var v int
	if err := s.DB.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v != 1 {
		t.Errorf("user_version = %d, %v", v, err)
	}
}

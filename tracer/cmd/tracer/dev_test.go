//go:build dev

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yingyeothon/service/tracer/internal/store"
)

func TestDevSeedRestamp(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "tracer.json")
	os.WriteFile(cfg, []byte(`{"resources":[{"id":"trc_seed01","writeKey":"aaaaaaaaaaaaaaaaaaaa"}]}`), 0o600)
	fixtures, _ := filepath.Glob("../../testdata/envelopes/*/*.envelope")
	args := append([]string{"seed", "-data", dir, "-config", cfg, "-resource", "trc_seed01", "-restamp"}, fixtures...)
	if err := dev(args); err != nil {
		t.Fatal(err)
	}
	// Session-only fixtures alone (no time-stamped rows) must not fail the restamp.
	if err := dev([]string{"seed", "-data", dir, "-config", cfg, "-resource", "trc_seed01", "-restamp", "../../testdata/envelopes/sentry-android/session-init.envelope"}); err != nil {
		t.Fatalf("session only: %v", err)
	}
	st, err := store.Open(context.Background(), filepath.Join(dir, "tracer.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	var newest int64
	st.DB.QueryRow("SELECT max(ts_ms) FROM events").Scan(&newest)
	if d := time.Since(time.UnixMilli(newest)); d < 0 || d > time.Minute {
		t.Fatalf("newest event %s ago", d)
	}
	var n int
	st.DB.QueryRow("SELECT count(*) FROM attachments").Scan(&n)
	if n != 2 {
		t.Fatalf("attachments %d", n)
	}
}

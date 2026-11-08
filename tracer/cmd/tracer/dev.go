//go:build dev

package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/ingest"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/store"
)

func init() { devMain = dev }

// dev seed loads fixture envelopes straight into a data dir (no HTTP, no
// quota), through the same normalize + writer path as ingest. With -restamp
// the newest stored time of the seeded rows is moved to now, so `--since`
// reads find them.
func dev(args []string) error {
	if len(args) == 0 || args[0] != "seed" {
		return errors.New("usage: tracer dev seed -data <dir> -config <tracer.json> -resource <trc_…> [-restamp] <fixture.envelope>…")
	}
	fs := flag.NewFlagSet("seed", flag.ContinueOnError)
	dataDir := fs.String("data", "tracer-data", "data dir (tracer.db + blobs/)")
	cfgPath := fs.String("config", "tracer.json", "local tracer.json")
	resID := fs.String("resource", "", "resource id from tracer.json")
	restamp := fs.Bool("restamp", false, "move the seeded rows' times so the newest is now")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	b, err := os.ReadFile(*cfgPath)
	if err != nil {
		return err
	}
	local, err := config.ParseLocal(b)
	if err != nil {
		return err
	}
	res, err := resource.NewLocal(local).Lookup(context.Background(), *resID)
	if err != nil {
		return fmt.Errorf("resource %q: %w", *resID, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	blobDir := filepath.Join(*dataDir, "blobs")
	if err := os.MkdirAll(blobDir, 0o700); err != nil {
		return err
	}
	st, err := store.Open(ctx, filepath.Join(*dataDir, "tracer.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	w := st.StartWriter(ctx)
	h := ingest.New(ingest.Options{Source: resource.NewLocal(local), Metrics: metrics.New(), Writer: w, BlobDir: blobDir,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	start := time.Now()
	for _, f := range fs.Args() {
		fh, err := os.Open(f)
		if err != nil {
			return err
		}
		id, err := h.Accept(ctx, res, io.Reader(fh), time.Now())
		fh.Close()
		if err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		fmt.Printf("seeded %s %s\n", filepath.Base(f), id)
	}
	if *restamp {
		if err := restampRows(ctx, st, res.ID, start.Add(-time.Second).UnixMilli()); err != nil {
			return err
		}
	}
	cancel()
	<-w.Done()
	return nil
}

// restampRows shifts the device-clock times of rows received in this run so
// that the newest becomes now.
func restampRows(ctx context.Context, st *store.Store, res string, sinceMs int64) error {
	var newest sql.NullInt64
	err := st.DB.QueryRowContext(ctx, `SELECT max(m) FROM (
		SELECT max(ts_ms) m FROM events WHERE resource_id=? AND received_ms>=?
		UNION ALL SELECT max(ts_ms) FROM logs WHERE resource_id=? AND received_ms>=?
		UNION ALL SELECT max(end_ms) FROM transactions WHERE resource_id=? AND received_ms>=?)`,
		res, sinceMs, res, sinceMs, res, sinceMs).Scan(&newest)
	if err != nil || !newest.Valid {
		return err // nothing time-stamped was seeded
	}
	d := time.Now().UnixMilli() - newest.Int64
	for _, q := range []string{
		`UPDATE breadcrumbs SET ts_ms = ts_ms + ? WHERE ts_ms IS NOT NULL AND event_row IN (SELECT id FROM events WHERE resource_id=? AND received_ms>=?)`,
		// Only groups made entirely of seeded events move; older groups keep their first_seen.
		`UPDATE issues SET first_seen_ms = first_seen_ms + ?, last_seen_ms = last_seen_ms + ? WHERE resource_id=? AND NOT EXISTS
			(SELECT 1 FROM events e WHERE e.resource_id=issues.resource_id AND e.group_key=issues.group_key AND e.received_ms < ?)`,
		`UPDATE events SET ts_ms = ts_ms + ? WHERE resource_id=? AND received_ms>=?`,
		`UPDATE logs SET ts_ms = ts_ms + ? WHERE resource_id=? AND received_ms>=?`,
		`UPDATE transactions SET start_ms = start_ms + ?, end_ms = end_ms + ? WHERE resource_id=? AND received_ms>=?`,
	} {
		var args []any
		switch {
		case q[7:13] == "issues":
			args = []any{d, d, res, sinceMs}
		case q[7:19] == "transactions":
			args = []any{d, d, res, sinceMs}
		default:
			args = []any{d, res, sinceMs}
		}
		if _, err := st.DB.ExecContext(ctx, q, args...); err != nil {
			return err
		}
	}
	fmt.Printf("restamped by %s\n", time.Duration(d)*time.Millisecond)
	return nil
}

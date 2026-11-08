// Package retention keeps tracer inside its bounds (docs/tracer.md _Storage_):
// rows and files older than the retention age, then the oldest data until
// the stage byte cap has headroom, then blob files no row names, then
// `PRAGMA incremental_vacuum`; and a periodic WAL checkpoint. Deletes run in
// small transactions so ingest and `/livez` never wait long on the lock.
package retention

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Defaults.
const (
	DefaultAge      = 30 * 24 * time.Hour
	DefaultInterval = time.Hour
	CheckpointEvery = 5 * time.Minute
	batchRows       = 1000
	eventBatchRows  = 200 // an event delete cascades to its breadcrumbs and tags
	lowWaterPercent = 80  // the cap pass stops at 80 %: room for the next envelopes
	// TriggerPercent: capacity above this wakes a pass early (see Trigger).
	TriggerPercent    = 95
	minTriggerGap     = time.Minute
	orphanGrace       = time.Hour
	maxCapPassBatches = 10_000
	maxDeletedList    = 1000 // the console's page of deleted ids
)

// Options configures a Retention.
type Options struct {
	DB         *sql.DB // the writable store connection
	DBPath     string
	BlobDir    string
	StageBytes int64
	Age        time.Duration
	Now        func() time.Time
	Log        *slog.Logger
	// Deleted (server mode) lists resources the console deleted long enough
	// ago to purge; an error or an empty list purges nothing.
	Deleted func(ctx context.Context) ([]string, error)
	// Purged is told each resource whose data was removed (cache eviction).
	Purged func(id string)
}

// Retention runs the passes.
type Retention struct {
	opt     Options
	trigger chan struct{}
	groups  map[[2]string]bool // issue groups touched by the current pass
	// purged: ids already purged by this process; the console lists a deleted
	// id for about a month, and nothing can write for it again.
	purged map[string]bool
}

// New builds a Retention.
func New(opt Options) *Retention {
	if opt.Age <= 0 {
		opt.Age = DefaultAge
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Log == nil {
		opt.Log = slog.Default()
	}
	return &Retention{opt: opt, trigger: make(chan struct{}, 1), purged: map[string]bool{}}
}

// Trigger asks Run for a pass now (at most one a minute): ingest refuses at
// the stage cap, so waiting for the hourly pass would refuse for up to an hour.
func (r *Retention) Trigger() {
	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

// Report says what one Once removed.
type Report struct {
	// Err is set when the pass stopped early; the counts are what it did.
	Err          error
	AgedRows     int64
	CapRows      int64
	BlobsRemoved int64
	Orphans      int64
	IssuesGone   int64
	BytesAfter   int64
	// PurgeErr is a purge failure the rest of the pass carried on past.
	PurgeErr error
	// PurgedResources / PurgedRows: data of console-deleted resources.
	PurgedResources int64
	PurgedRows      int64
}

// Run does a first pass after `first`, then one every interval, and a WAL
// checkpoint every few minutes. after (optional) sees each report.
func (r *Retention) Run(ctx context.Context, first, interval time.Duration, after func(Report)) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(first):
	}
	r.pass(ctx, after, false)
	last := time.Now()
	pass := time.NewTicker(interval)
	cp := time.NewTicker(CheckpointEvery)
	defer pass.Stop()
	defer cp.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-cp.C:
			r.checkpoint(ctx, "PASSIVE") // never waits on readers, so /livez is not held up
		case <-pass.C:
			r.pass(ctx, after, false)
			last = time.Now()
		case <-r.trigger:
			if time.Since(last) >= minTriggerGap {
				r.pass(ctx, after, true)
				last = time.Now()
			}
		}
	}
}

func (r *Retention) pass(ctx context.Context, after func(Report), triggered bool) {
	rep, err := r.Once(ctx)
	rep.Err = err
	if after != nil {
		defer after(rep) // partial work is reported too
	}
	if err != nil {
		r.opt.Log.Warn("retention pass failed", "err", err)
		return
	}
	if triggered && rep.CapRows == 0 {
		// The stage-cap check (file sizes) and this pass (live bytes) disagree:
		// free pages vacuum did not return, or the cap is too small.
		r.opt.Log.Warn("triggered retention pass freed nothing", "liveBytes", rep.BytesAfter, "stageBytes", r.opt.StageBytes)
	}
	if rep.AgedRows+rep.CapRows+rep.Orphans > 0 {
		r.opt.Log.Info("retention pass", "aged", rep.AgedRows, "cap", rep.CapRows, "blobs", rep.BlobsRemoved,
			"orphans", rep.Orphans, "issuesGone", rep.IssuesGone, "bytes", rep.BytesAfter)
	}
}

// Once runs the passes in order.
func (r *Retention) Once(ctx context.Context) (Report, error) {
	var rep Report
	cutoff := r.opt.Now().Add(-r.opt.Age).UnixMilli()
	// A clock jumped forward must not age out everything: never cut past the
	// newest received row minus the age.
	var newest sql.NullInt64
	if err := r.opt.DB.QueryRowContext(ctx, `SELECT max(m) FROM (SELECT max(received_ms) m FROM events
		UNION ALL SELECT max(received_ms) FROM logs UNION ALL SELECT max(received_ms) FROM attachments)`).Scan(&newest); err != nil {
		return rep, err
	}
	if newest.Valid && cutoff > newest.Int64-r.opt.Age.Milliseconds() {
		cutoff = newest.Int64 - r.opt.Age.Milliseconds()
	}
	groups := map[[2]string]bool{}
	r.groups = groups
	if err := r.purgeDeleted(ctx, &rep); err != nil {
		// Never let a failing purge stop the age and cap passes the disk needs.
		rep.PurgeErr = err
		r.opt.Log.Warn("deleted-resource purge failed; continuing with retention", "err", err)
	}
	n, blobs, err := r.deleteBefore(ctx, cutoff)
	rep.AgedRows, rep.BlobsRemoved = n, blobs+rep.BlobsRemoved
	if err != nil {
		return rep, err
	}
	day := time.UnixMilli(cutoff).UTC().Format("2006-01-02")
	for _, q := range []string{`DELETE FROM drops WHERE day < ?`, `DELETE FROM daily_bytes WHERE day < ?`} {
		if _, err := r.opt.DB.ExecContext(ctx, q, day); err != nil {
			return rep, err
		}
	}
	if rep.CapRows, blobs, err = r.capPass(ctx); err != nil {
		return rep, err
	}
	rep.BlobsRemoved += blobs
	if rep.IssuesGone, err = r.refreshIssues(ctx, groups); err != nil {
		return rep, err
	}
	if rep.Orphans, err = r.sweepOrphans(ctx); err != nil {
		return rep, err
	}
	if err := r.vacuum(ctx); err != nil {
		return rep, err
	}
	// PASSIVE: a TRUNCATE waits on readers while holding writers off (past the
	// /livez deadline); journal_size_limit trims the WAL file when it resets.
	r.checkpoint(ctx, "PASSIVE")
	rep.BytesAfter, err = r.liveBytes(ctx) // what the cap pass measures
	return rep, err
}

// deleteBefore removes rows received before cutoff (and their blob files).
func (r *Retention) deleteBefore(ctx context.Context, cutoff int64) (rows, blobs int64, err error) {
	n, err := r.deleteEvents(ctx, cutoff)
	rows += n
	if err != nil {
		return rows, blobs, err
	}
	for _, q := range []string{
		`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE received_ms < ? LIMIT ?)`,
		`DELETE FROM transactions WHERE id IN (SELECT id FROM transactions WHERE received_ms < ? LIMIT ?)`,
		// sessions is WITHOUT ROWID: batch on its key.
		`DELETE FROM sessions WHERE (resource_id, sid) IN (SELECT resource_id, sid FROM sessions WHERE received_ms < ? LIMIT ?)`,
	} {
		n, err := r.batched(ctx, q, cutoff, batchRows)
		rows += n
		if err != nil {
			return rows, blobs, err
		}
	}
	an, b, err := r.deleteAttachments(ctx, `received_ms < ?`, cutoff)
	return rows + an, blobs + b, err
}

// purgeDeleted removes every row and file of the resources the console
// lists as deleted (docs/tracer.md _Storage_). The console client asks only
// after `/tr/health` proves the right console; a failed or empty answer
// purges nothing and is not an error of the pass.
func (r *Retention) purgeDeleted(ctx context.Context, rep *Report) error {
	if r.opt.Deleted == nil {
		return nil
	}
	ids, err := r.opt.Deleted(ctx)
	if err != nil {
		r.opt.Log.Warn("deleted-resource list unavailable; purging nothing", "err", err)
		return nil
	}
	if len(r.purged) > 4*maxDeletedList {
		clear(r.purged) // a restart forgets it as well; a repeat is only work
	}
	for _, id := range ids {
		if r.purged[id] {
			continue
		}
		n, b, err := r.purgeResource(ctx, id)
		rep.PurgedRows += n
		rep.BlobsRemoved += b
		if err != nil {
			return err
		}
		if n > 0 {
			rep.PurgedResources++
			r.opt.Log.Info("purged deleted resource", "resource", id, "rows", n, "blobs", b)
		}
		r.purged[id] = true
		if r.opt.Purged != nil {
			r.opt.Purged(id)
		}
	}
	return nil
}

func (r *Retention) purgeResource(ctx context.Context, id string) (rows, blobs int64, err error) {
	// Events first (cascading breadcrumbs and tags); issue rows go with them below.
	n, err := r.deleteEventsWhere(ctx, `resource_id = ?`, id)
	rows += n
	if err != nil {
		return rows, blobs, err
	}
	for _, q := range []string{
		`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE resource_id = ? LIMIT ?)`,
		`DELETE FROM transactions WHERE id IN (SELECT id FROM transactions WHERE resource_id = ? LIMIT ?)`,
		`DELETE FROM sessions WHERE (resource_id, sid) IN (SELECT resource_id, sid FROM sessions WHERE resource_id = ? LIMIT ?)`,
		`DELETE FROM issues WHERE (resource_id, group_key) IN (SELECT resource_id, group_key FROM issues WHERE resource_id = ? LIMIT ?)`,
		`DELETE FROM drops WHERE (resource_id, day, item_type, reason) IN (SELECT resource_id, day, item_type, reason FROM drops WHERE resource_id = ? LIMIT ?)`,
		`DELETE FROM daily_bytes WHERE (resource_id, day) IN (SELECT resource_id, day FROM daily_bytes WHERE resource_id = ? LIMIT ?)`,
	} {
		n, err := r.batched(ctx, q, id, batchRows)
		rows += n
		if err != nil {
			return rows, blobs, err
		}
	}
	// The issue rows are gone already: nothing left to recount for this id.
	for g := range r.groups {
		if g[0] == id {
			delete(r.groups, g)
		}
	}
	an, b, err := r.deleteAttachments(ctx, `resource_id = ?`, id)
	return rows + an, blobs + b, err
}

// capPass deletes the oldest received data, an hour at a time, until the
// used bytes are under the low-water mark of the stage cap.
func (r *Retention) capPass(ctx context.Context) (rows, blobs int64, err error) {
	if r.opt.StageBytes <= 0 {
		return 0, 0, nil
	}
	limit := r.opt.StageBytes * lowWaterPercent / 100
	var prevUsed int64
	for i := 0; i < maxCapPassBatches; i++ {
		// Fold the WAL first: deletes grow it, and an untruncated WAL would
		// make the pass delete far more than it needs to.
		used, err := r.liveBytes(ctx)
		if err != nil || used <= limit {
			return rows, blobs, err
		}
		if i > 0 && used >= prevUsed {
			// Deleting did not lower the live bytes: stop rather than walk
			// through every hour of data.
			r.opt.Log.Warn("retention cap pass made no progress", "liveBytes", used, "stageBytes", r.opt.StageBytes)
			return rows, blobs, nil
		}
		prevUsed = used
		var oldest sql.NullInt64
		if err := r.opt.DB.QueryRowContext(ctx, `SELECT min(m) FROM (
			SELECT min(received_ms) m FROM events UNION ALL SELECT min(received_ms) FROM logs
			UNION ALL SELECT min(received_ms) FROM transactions UNION ALL SELECT min(received_ms) FROM attachments
			UNION ALL SELECT min(received_ms) FROM sessions)`).Scan(&oldest); err != nil {
			return rows, blobs, err
		}
		if !oldest.Valid {
			return rows, blobs, nil // nothing left to delete
		}
		n, b, err := r.deleteBefore(ctx, oldest.Int64+time.Hour.Milliseconds())
		rows, blobs = rows+n, blobs+b
		if err != nil {
			return rows, blobs, err
		}
		if err := r.vacuum(ctx); err != nil {
			return rows, blobs, err
		}
	}
	return rows, blobs, nil
}

func (r *Retention) deleteAttachments(ctx context.Context, cond string, arg any) (rows, blobs int64, err error) {
	for {
		list, err := r.collect(ctx, `SELECT id, path FROM attachments WHERE `+cond+` LIMIT ?`, arg, batchRows)
		if err != nil || len(list) == 0 {
			return rows, blobs, err
		}
		tx, err := r.opt.DB.BeginTx(ctx, nil)
		if err != nil {
			return rows, blobs, err
		}
		for _, a := range list {
			if _, err := tx.ExecContext(ctx, `DELETE FROM attachments WHERE id = ?`, a.id); err != nil {
				tx.Rollback()
				return rows, blobs, err
			}
		}
		if err := tx.Commit(); err != nil {
			return rows, blobs, err
		}
		rows += int64(len(list))
		// Files go after the rows: a crash in between leaves orphans, which the sweep removes.
		for _, a := range list {
			if os.Remove(r.blobPath(a.path)) == nil {
				blobs++
			}
		}
	}
}

type attRow struct {
	id   int64
	path string
}

func (r *Retention) collect(ctx context.Context, q string, args ...any) ([]attRow, error) {
	rows, err := r.opt.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []attRow
	for rows.Next() {
		var a attRow
		if err := rows.Scan(&a.id, &a.path); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// blobPath joins a stored relative path under the blob root, never above it.
func (r *Retention) blobPath(rel string) string {
	return filepath.Join(r.opt.BlobDir, filepath.Clean("/"+rel))
}

// batched repeats a `… LIMIT ?` delete until it removes less than a batch.
func (r *Retention) batched(ctx context.Context, q string, arg any, batch int) (int64, error) {
	var total int64
	for {
		res, err := r.opt.DB.ExecContext(ctx, q, arg, batch)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
		if n < int64(batch) {
			return total, nil
		}
	}
}

// deleteEvents removes events (cascading breadcrumbs and tags) in small
// batches and remembers the issue groups they belonged to.
func (r *Retention) deleteEvents(ctx context.Context, cutoff int64) (int64, error) {
	return r.deleteEventsWhere(ctx, `received_ms < ?`, cutoff)
}

func (r *Retention) deleteEventsWhere(ctx context.Context, cond string, arg any) (int64, error) {
	var total int64
	for {
		rows, err := r.opt.DB.QueryContext(ctx, `SELECT id, resource_id, coalesce(group_key,'') FROM events WHERE `+cond+` LIMIT ?`, arg, eventBatchRows)
		if err != nil {
			return total, err
		}
		var ids []any
		for rows.Next() {
			var id int64
			var res, g string
			if err := rows.Scan(&id, &res, &g); err != nil {
				rows.Close()
				return total, err
			}
			ids = append(ids, id)
			if g != "" && r.groups != nil {
				r.groups[[2]string{res, g}] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil || len(ids) == 0 {
			return total, err
		}
		q := `DELETE FROM events WHERE id IN (?` + strings.Repeat(",?", len(ids)-1) + `)`
		res, err := r.opt.DB.ExecContext(ctx, q, ids...)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
		if len(ids) < eventBatchRows {
			return total, nil
		}
	}
}

// refreshIssues recounts the issue groups whose events this pass deleted,
// one small statement per group, and drops groups left with no events.
func (r *Retention) refreshIssues(ctx context.Context, groups map[[2]string]bool) (int64, error) {
	var gone int64
	for g := range groups {
		var count int64
		var first, last sql.NullInt64
		if err := r.opt.DB.QueryRowContext(ctx, `SELECT count(*), min(ts_ms), max(ts_ms) FROM events WHERE resource_id = ? AND group_key = ?`, g[0], g[1]).Scan(&count, &first, &last); err != nil {
			return gone, err
		}
		if count == 0 {
			res, err := r.opt.DB.ExecContext(ctx, `DELETE FROM issues WHERE resource_id = ? AND group_key = ?`, g[0], g[1])
			if err != nil {
				return gone, err
			}
			n, _ := res.RowsAffected()
			gone += n
			continue
		}
		if _, err := r.opt.DB.ExecContext(ctx, `UPDATE issues SET count = ?, first_seen_ms = ?, last_seen_ms = ?,
			latest_event_id = (SELECT event_id FROM events WHERE resource_id = ? AND group_key = ? ORDER BY ts_ms DESC, id DESC LIMIT 1)
			WHERE resource_id = ? AND group_key = ?`,
			count, first.Int64, last.Int64, g[0], g[1], g[0], g[1]); err != nil {
			return gone, err
		}
	}
	return gone, nil
}

// sweepOrphans removes blob files no attachment row names (crash leftovers),
// older than an hour so an envelope being written is never touched, and
// empty day directories.
func (r *Retention) sweepOrphans(ctx context.Context) (int64, error) {
	var removed int64
	cutoff := r.opt.Now().Add(-orphanGrace)
	var dirs []string
	err := filepath.WalkDir(r.opt.BlobDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			if p != r.opt.BlobDir {
				dirs = append(dirs, p)
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().After(cutoff) {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, ".tmp-") {
			var one int
			err := r.opt.DB.QueryRowContext(ctx, `SELECT 1 FROM attachments WHERE blob_id = ?`, name).Scan(&one)
			if err == nil {
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		if os.Remove(p) == nil {
			removed++
		}
		return nil
	})
	for i := len(dirs) - 1; i >= 0; i-- {
		// Only old, empty directories: ingest creates today's directory just
		// before it opens a temp file there.
		if st, err := os.Stat(dirs[i]); err == nil && st.ModTime().Before(cutoff) {
			os.Remove(dirs[i]) // fails unless empty
		}
	}
	return removed, err
}

// liveBytes is used pages plus blob bytes: what deleting rows lowers at once
// (the WAL grows with every delete, so it is no measure of progress).
func (r *Retention) liveBytes(ctx context.Context) (int64, error) {
	var pages, free, size, blobs int64
	for q, dst := range map[string]*int64{`PRAGMA page_count`: &pages, `PRAGMA freelist_count`: &free, `PRAGMA page_size`: &size,
		`SELECT coalesce(sum(size), 0) FROM attachments`: &blobs} {
		if err := r.opt.DB.QueryRowContext(ctx, q).Scan(dst); err != nil {
			return 0, err
		}
	}
	return (pages-free)*size + blobs, nil
}

// vacuum returns free pages to the file system a slice at a time, so the
// write lock is never held for a whole large freelist.
func (r *Retention) vacuum(ctx context.Context) error {
	for i := 0; i < 10_000; i++ {
		var free int64
		if err := r.opt.DB.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&free); err != nil || free == 0 {
			return err
		}
		if _, err := r.opt.DB.ExecContext(ctx, `PRAGMA incremental_vacuum(2048)`); err != nil {
			return err
		}
	}
	return nil
}

// checkpoint runs a WAL checkpoint; a busy result (readers in the way) is
// reported as a debug line, not an error — the next one catches up.
func (r *Retention) checkpoint(ctx context.Context, mode string) {
	var busy, logPages, done int64
	if err := r.opt.DB.QueryRowContext(ctx, `PRAGMA wal_checkpoint(`+mode+`)`).Scan(&busy, &logPages, &done); err != nil {
		r.opt.Log.Warn("wal checkpoint failed", "err", err)
		return
	}
	if busy != 0 {
		r.opt.Log.Debug("wal checkpoint busy", "mode", mode, "logPages", logPages, "checkpointed", done)
	}
}

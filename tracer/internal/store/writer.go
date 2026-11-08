package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync/atomic"
	"time"
)

// ErrClosed is returned once the writer has stopped.
var ErrClosed = errors.New("store: writer closed")

// Writer is the single writer goroutine: every ingest batch goes through it,
// several queued batches share one transaction, and each caller waits for
// its own result. Batches are small (one envelope), so a transaction stays
// well under the `/livez` deadline.
type Writer struct {
	db   *sql.DB
	jobs chan *job
	done chan struct{}
	// maxGroup and maxRows bound one transaction.
	maxGroup int
	maxRows  int
	// maxTx is the longest transaction so far (microseconds), for /metrics.
	maxTx atomic.Int64
}

// MaxTxMicros reports the longest transaction since start.
func (w *Writer) MaxTxMicros() int64 { return w.maxTx.Load() }

type job struct {
	b   *Batch
	res Result
	err error
	ok  chan struct{}
}

// StartWriter starts the writer goroutine; it stops when ctx ends (queued
// jobs are answered with ErrClosed).
func (s *Store) StartWriter(ctx context.Context) *Writer {
	w := &Writer{db: s.DB, jobs: make(chan *job, 64), done: make(chan struct{}), maxGroup: 16, maxRows: 4000}
	go w.loop(ctx)
	return w
}

// Done is closed once the loop has exited.
func (w *Writer) Done() <-chan struct{} { return w.done }

// Write commits b and reports duplicates. Blob files of duplicate
// attachments are removed before it returns.
func (w *Writer) Write(ctx context.Context, b *Batch) (Result, error) {
	j := &job{b: b, ok: make(chan struct{})}
	select {
	case w.jobs <- j:
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-w.done:
		return Result{}, ErrClosed
	}
	select {
	case <-j.ok:
		return j.res, j.err
	case <-w.done:
		// The loop answers every job it took before closing done.
		select {
		case <-j.ok:
			return j.res, j.err
		default:
			return Result{}, ErrClosed
		}
	}
}

func (w *Writer) loop(ctx context.Context) {
	defer close(w.done)
	for {
		select {
		case <-ctx.Done():
			w.drainClosed()
			return
		case j := <-w.jobs:
			// Group what is already queued, within a row budget, so one
			// transaction stays well under the 2 s /livez deadline.
			group, rows := []*job{j}, j.b.Rows()
		more:
			for len(group) < w.maxGroup && rows < w.maxRows {
				select {
				case j2 := <-w.jobs:
					group = append(group, j2)
					rows += j2.b.Rows()
				default:
					break more
				}
			}
			w.commit(group)
		}
	}
}

func (w *Writer) drainClosed() {
	for {
		select {
		case j := <-w.jobs:
			j.err = ErrClosed
			close(j.ok)
		default:
			return
		}
	}
}

// commit applies a group in one transaction. If the group fails, each job
// is retried alone so one bad batch does not fail its neighbours.
func (w *Writer) commit(group []*job) {
	if len(group) > 1 {
		if err := w.tx(group); err == nil {
			w.finish(group)
			return
		}
		for _, j := range group {
			j.res = Result{}
			w.single(j)
		}
		return
	}
	w.single(group[0])
}

func (w *Writer) single(j *job) {
	if err := w.tx([]*job{j}); err != nil {
		j.err = err
		close(j.ok)
		return
	}
	w.finish([]*job{j})
}

// finish removes duplicate blobs after the commit and answers the jobs.
func (w *Writer) finish(group []*job) {
	for _, j := range group {
		for _, p := range j.res.dupBlobs {
			if os.Remove(p) == nil {
				j.res.RemovedBlobs++
			}
		}
		j.res.dupBlobs = nil
		close(j.ok)
	}
}

func (w *Writer) tx(group []*job) error {
	start := time.Now()
	defer func() {
		d := time.Since(start).Microseconds()
		for cur := w.maxTx.Load(); d > cur && !w.maxTx.CompareAndSwap(cur, d); cur = w.maxTx.Load() {
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, j := range group {
		res, err := apply(ctx, tx, j.b)
		if err != nil {
			return err
		}
		j.res = res
	}
	return tx.Commit()
}

func apply(ctx context.Context, tx *sql.Tx, b *Batch) (Result, error) {
	var res Result
	r, at := b.ResourceID, b.ReceivedMs
	for i := range b.Events {
		e := &b.Events[i]
		out, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO events
			(resource_id, event_id, type, ts_ms, received_ms, level, platform, release, dist, environment,
			 trace_id, user_id, device, os, group_key, title, message, exception_type, exception_value,
			 associated_event_id, json)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r, e.EventID, e.Type, e.TsMs, at, ns(e.Level), ns(e.Platform), ns(e.Release), ns(e.Dist), ns(e.Environment),
			ns(e.TraceID), ns(e.UserID), ns(e.Device), ns(e.OS), ns(e.GroupKey), ns(e.Title), ns(e.Message),
			ns(e.ExceptionType), ns(e.ExceptionValue), ns(e.AssociatedEventID), string(e.JSON))
		if err != nil {
			return res, err
		}
		if n, _ := out.RowsAffected(); n == 0 {
			res.DuplicateEvents++
			res.DuplicateRows++
			continue
		}
		row, err := out.LastInsertId()
		if err != nil {
			return res, err
		}
		for _, t := range e.Tags {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO event_tags (event_row, resource_id, key, value) VALUES (?,?,?,?)`, row, r, t[0], t[1]); err != nil {
				return res, err
			}
		}
		for _, bc := range e.Breadcrumbs {
			if _, err := tx.ExecContext(ctx, `INSERT INTO breadcrumbs (event_row, resource_id, ts_ms, type, category, level, message, data_json) VALUES (?,?,?,?,?,?,?,?)`,
				row, r, ni(bc.TsMs), ns(bc.Type), ns(bc.Category), ns(bc.Level), ns(bc.Message), nb(bc.DataJSON)); err != nil {
				return res, err
			}
		}
		if e.GroupKey != "" {
			// SET expressions see the row's old values, so the CASEs compare against the previous last_seen_ms.
			if _, err := tx.ExecContext(ctx, `INSERT INTO issues (resource_id, group_key, title, level, count, first_seen_ms, last_seen_ms, latest_event_id)
				VALUES (?,?,?,?,1,?,?,?)
				ON CONFLICT (resource_id, group_key) DO UPDATE SET
				  count = count + 1,
				  first_seen_ms = min(first_seen_ms, excluded.first_seen_ms),
				  title = CASE WHEN excluded.last_seen_ms >= last_seen_ms THEN excluded.title ELSE title END,
				  level = CASE WHEN excluded.last_seen_ms >= last_seen_ms THEN excluded.level ELSE level END,
				  latest_event_id = CASE WHEN excluded.last_seen_ms >= last_seen_ms THEN excluded.latest_event_id ELSE latest_event_id END,
				  last_seen_ms = max(last_seen_ms, excluded.last_seen_ms)`,
				r, e.GroupKey, ns(e.Title), ns(e.Level), e.TsMs, e.TsMs, e.EventID); err != nil {
				return res, err
			}
		}
	}
	for _, t := range b.Transactions {
		out, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO transactions
			(resource_id, event_id, trace_id, name, op, status, start_ms, end_ms, received_ms, release, environment, device, json)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r, t.EventID, ns(t.TraceID), ns(t.Name), ns(t.Op), ns(t.Status), t.StartMs, ni(t.EndMs), at,
			ns(t.Release), ns(t.Environment), ns(t.Device), string(t.JSON))
		if err != nil {
			return res, err
		}
		if n, _ := out.RowsAffected(); n == 0 {
			res.DuplicateRows++
		}
	}
	for _, l := range b.Logs {
		out, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO logs
			(resource_id, ts_ms, received_ms, level, body, trace_id, span_id, release, environment, user_id, device, attributes_json, dedupe_key)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r, l.TsMs, at, ns(l.Level), ns(l.Body), ns(l.TraceID), ns(l.SpanID), ns(l.Release), ns(l.Environment),
			ns(l.UserID), ns(l.Device), nb(l.AttributesJSON), l.DedupeKey)
		if err != nil {
			return res, err
		}
		if n, _ := out.RowsAffected(); n == 0 {
			res.DuplicateRows++
		}
	}
	for _, s := range b.Sessions {
		// docs/tracer.md _Ingest_: terminal status beats ok, then the higher
		// (seq, updated_ms); errors max; started_ms/did/release keep the first value.
		if _, err := tx.ExecContext(ctx, `INSERT INTO sessions
			(resource_id, sid, did, status, errors, seq, started_ms, updated_ms, release, environment, received_ms)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT (resource_id, sid) DO UPDATE SET
			  status = CASE WHEN `+newWins+` THEN excluded.status ELSE status END,
			  seq = CASE WHEN `+newWins+` THEN excluded.seq ELSE seq END,
			  updated_ms = CASE WHEN `+newWins+` THEN excluded.updated_ms ELSE updated_ms END,
			  errors = max(errors, excluded.errors),
			  started_ms = coalesce(started_ms, excluded.started_ms),
			  did = coalesce(did, excluded.did),
			  release = coalesce(release, excluded.release),
			  environment = coalesce(environment, excluded.environment),
			  received_ms = max(received_ms, excluded.received_ms)`,
			r, s.SID, ns(s.DID), s.Status, s.Errors, s.Seq, ni(s.StartedMs), s.UpdatedMs, ns(s.Release), ns(s.Environment), at); err != nil {
			return res, err
		}
	}
	for i := range b.Attachments {
		a := &b.Attachments[i]
		out, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO attachments
			(resource_id, event_id, blob_id, path, filename, content_type, attachment_type, size, sha256, received_ms)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			r, ns(a.EventID), a.BlobID, a.Path, ns(a.Filename), ns(a.ContentType), ns(a.AttachmentType), a.Size, a.SHA256, at)
		if err != nil {
			return res, err
		}
		if n, _ := out.RowsAffected(); n == 0 {
			res.DuplicateRows++
			res.DuplicateBytes += a.Size + b.AttachmentOverhead
			if a.AbsPath != "" {
				res.dupBlobs = append(res.dupBlobs, a.AbsPath) // removed after the commit
			}
		}
	}
	for _, d := range b.Drops {
		if err := addDrop(ctx, tx, b.Day, r, d); err != nil {
			return res, err
		}
	}
	if charged := b.Bytes - res.DuplicateBytes; charged > 0 || b.QuotaHitMs > 0 {
		if _, err := tx.ExecContext(ctx, `INSERT INTO daily_bytes (resource_id, day, bytes, quota_hit_ms) VALUES (?,?,?,?)
			ON CONFLICT (resource_id, day) DO UPDATE SET bytes = bytes + excluded.bytes, quota_hit_ms = coalesce(quota_hit_ms, excluded.quota_hit_ms)`,
			r, b.Day, max(charged, 0), ni(b.QuotaHitMs)); err != nil {
			return res, err
		}
	}
	return res, nil
}

const terminal = `('exited','crashed','abnormal')`

// newWins: the incoming update replaces status/seq/updated_ms.
const newWins = `((excluded.status IN ` + terminal + ` AND status NOT IN ` + terminal + `)
	OR ((excluded.status IN ` + terminal + `) = (status IN ` + terminal + `)
	    AND (excluded.seq > seq OR (excluded.seq = seq AND excluded.updated_ms > updated_ms))))`

func addDrop(ctx context.Context, tx *sql.Tx, day, resource string, d Drop) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO drops (day, resource_id, item_type, reason, count, bytes) VALUES (?,?,?,?,?,?)
		ON CONFLICT (resource_id, day, item_type, reason) DO UPDATE SET count = count + excluded.count, bytes = bytes + excluded.bytes`,
		day, resource, d.ItemType, d.Reason, d.Count, d.Bytes)
	return err
}

// RecordDrops writes drop counters outside an envelope batch (refusals that
// stored nothing). It goes through the writer like everything else.
func (w *Writer) RecordDrops(ctx context.Context, resource, day string, drops ...Drop) error {
	_, err := w.Write(ctx, &Batch{ResourceID: resource, Day: day, Drops: drops})
	return err
}

// DailyBytes reads a resource's counter for a UTC day.
func (s *Store) DailyBytes(ctx context.Context, resource, day string) (bytes int64, quotaHit bool, err error) {
	var hit sql.NullInt64
	err = s.DB.QueryRowContext(ctx, `SELECT bytes, quota_hit_ms FROM daily_bytes WHERE resource_id = ? AND day = ?`, resource, day).Scan(&bytes, &hit)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return bytes, hit.Valid, err
}

// BlobBytes sums attachment sizes (stage byte accounting).
func (s *Store) BlobBytes(ctx context.Context) (int64, error) {
	var n int64
	err := s.DB.QueryRowContext(ctx, `SELECT coalesce(sum(size), 0) FROM attachments`).Scan(&n)
	return n, err
}

func ns(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ni(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}

func nb(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

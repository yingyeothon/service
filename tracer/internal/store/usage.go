package store

import (
	"context"
	"database/sql"
	"strings"
)

// UsageDay is one UTC day of a resource for console `GET /tr/usage`
// (services/console/src/tracer-usage.ts): stored bytes and quota drops.
type UsageDay struct {
	Day             string `json:"day"`
	Bytes           int64  `json:"bytes"`
	QuotaAttachment int64  `json:"quotaAttachment"`
	QuotaRefused    int64  `json:"quotaRefused"`
}

// MaxQuotaHits bounds the `quotaDay` answer (the console accepts ≤ 100 ids).
const MaxQuotaHits = 100

// Usage reads the days (YYYY-MM-DD, any order) of each id from db (the
// read-only connection). Days with nothing recorded and ids with no day are
// absent; each id's days come newest first.
func Usage(ctx context.Context, db *sql.DB, ids, days []string) (map[string][]UsageDay, error) {
	out := map[string][]UsageDay{}
	if len(ids) == 0 || len(days) == 0 {
		return out, nil
	}
	args := make([]any, 0, 2*(len(ids)+len(days)))
	for _, id := range ids {
		args = append(args, id)
	}
	for _, d := range days {
		args = append(args, d)
	}
	args = append(args, args...)
	in := func(n int) string { return "(?" + strings.Repeat(",?", n-1) + ")" }
	q := `SELECT resource_id, day, sum(b), sum(qa), sum(qr) FROM (
		SELECT resource_id, day, bytes b, 0 qa, 0 qr FROM daily_bytes
		 WHERE resource_id IN ` + in(len(ids)) + ` AND day IN ` + in(len(days)) + `
		UNION ALL
		SELECT resource_id, day, 0,
		       CASE WHEN reason = 'quota_attachment' THEN count ELSE 0 END,
		       CASE WHEN reason = 'quota_refused' THEN count ELSE 0 END
		  FROM drops
		 WHERE resource_id IN ` + in(len(ids)) + ` AND day IN ` + in(len(days)) + `
		   AND reason IN ('quota_attachment', 'quota_refused'))
		GROUP BY resource_id, day ORDER BY resource_id, day DESC`
	return scanUsage(ctx, db, q, args...)
}

// QuotaHits lists the resources that reached their quota on day (a recorded
// crossing or a quota drop), with that day's row, largest first.
func QuotaHits(ctx context.Context, db *sql.DB, day string) (map[string][]UsageDay, error) {
	q := `SELECT resource_id, day, sum(b), sum(qa), sum(qr) FROM (
		SELECT resource_id, day, bytes b, 0 qa, 0 qr FROM daily_bytes WHERE day = ?
		UNION ALL
		SELECT resource_id, day, 0,
		       CASE WHEN reason = 'quota_attachment' THEN count ELSE 0 END,
		       CASE WHEN reason = 'quota_refused' THEN count ELSE 0 END
		  FROM drops WHERE day = ? AND reason IN ('quota_attachment', 'quota_refused'))
		WHERE resource_id IN (
		  SELECT resource_id FROM daily_bytes WHERE day = ? AND quota_hit_ms IS NOT NULL
		  UNION SELECT resource_id FROM drops WHERE day = ? AND reason IN ('quota_attachment', 'quota_refused') AND count > 0)
		GROUP BY resource_id, day ORDER BY sum(b) DESC LIMIT ?`
	return scanUsage(ctx, db, q, day, day, day, day, MaxQuotaHits)
}

func scanUsage(ctx context.Context, db *sql.DB, q string, args ...any) (map[string][]UsageDay, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]UsageDay{}
	for rows.Next() {
		var id string
		var d UsageDay
		if err := rows.Scan(&id, &d.Day, &d.Bytes, &d.QuotaAttachment, &d.QuotaRefused); err != nil {
			return nil, err
		}
		out[id] = append(out[id], d)
	}
	return out, rows.Err()
}

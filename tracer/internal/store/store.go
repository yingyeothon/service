// Package store owns the SQLite database: connection pragmas, schema migrations
// and (from todo/85 P3 on) the single writer goroutine and read queries.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strings"

	_ "modernc.org/sqlite" // pure Go driver: keeps CGO_ENABLED=0 builds possible
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Store wraps the database handle.
type Store struct {
	DB *sql.DB
}

// Open opens (creating if needed) the database at path and applies migrations.
// auto_vacuum is listed first because it only takes effect before the first table exists.
func Open(ctx context.Context, path string) (*Store, error) {
	q := url.Values{}
	for _, p := range []string{
		"auto_vacuum(INCREMENTAL)",
		"journal_mode(WAL)",
		"synchronous(NORMAL)",
		"busy_timeout(5000)",
		"foreign_keys(1)",
		"journal_size_limit(67108864)", // a checkpointed WAL is truncated back to 64 MiB at most
	} {
		q.Add("_pragma", p)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	s := &Store{DB: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.DB.Close() }

// Writable proves the database accepts a write (the `/livez` probe): it takes
// the write lock with a write to `meta` and rolls back, so nothing is written.
func (s *Store) Writable(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, "INSERT OR REPLACE INTO meta(k, v) VALUES ('livez', '1')")
	return err
}

// migrate applies migrations/NNNN_*.sql in order, tracked by PRAGMA user_version.
// Migrations are append-only: never edit one that has shipped.
func (s *Store) migrate(ctx context.Context) error {
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)

	var current int
	if err := s.DB.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	for i, name := range names {
		version := i + 1
		if !strings.HasPrefix(name, fmt.Sprintf("migrations/%04d_", version)) {
			return fmt.Errorf("store: migration %s is out of sequence (want %04d_)", name, version)
		}
		if version <= current {
			continue
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := s.DB.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

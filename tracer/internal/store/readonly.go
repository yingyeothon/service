package store

import (
	"context"
	"database/sql"
	"net/url"
)

// OpenReadOnly opens the database for the read API: `mode=ro` plus
// `query_only`, so a read path cannot write even by mistake. The writer
// (Open) must have created and migrated the file first.
func OpenReadOnly(ctx context.Context, path string) (*sql.DB, error) {
	q := url.Values{}
	q.Set("mode", "ro")
	for _, p := range []string{"busy_timeout(5000)", "query_only(1)", "foreign_keys(1)"} {
		q.Add("_pragma", p)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

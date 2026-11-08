package capacity

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAllow(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "t.db")
	os.WriteFile(db, make([]byte, 100), 0o600)
	os.WriteFile(db+"-wal", make([]byte, 50), 0o600)
	pct, inodes := 10, 50
	var volErr error
	c := New(Options{DBPath: db, DataDir: dir, StageBytes: 1000, MaxPct: 70,
		BlobBytes: func(context.Context) (int64, error) { return 300, nil },
		Volume:    func(string) (Usage, error) { return Usage{UsedPct: pct, InodesFreePct: inodes}, volErr }})
	if c.Allow(1) {
		t.Fatal("must refuse before the first measurement succeeds")
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s := c.Snapshot(); s.Total != 450 {
		t.Fatalf("total %d", s.Total)
	}
	if !c.Allow(550) || c.Allow(551) {
		t.Fatal("stage cap boundary")
	}
	c.Add(500)
	if c.Allow(51) {
		t.Fatal("accepted bytes since refresh not counted")
	}
	inodes = 5
	c.Refresh(context.Background())
	if c.Allow(1) {
		t.Fatal("low free inodes must refuse")
	}
	inodes = 50
	pct = 70
	c.Refresh(context.Background())
	if c.Allow(1) {
		t.Fatal("70 % root usage must refuse")
	}
	pct, volErr = 10, errors.New("statfs")
	c.Refresh(context.Background())
	if c.Allow(1) {
		t.Fatal("failed measurement must refuse")
	}
}

func TestStatfs(t *testing.T) {
	u, err := Statfs(t.TempDir())
	if err != nil || u.UsedPct < 0 || u.UsedPct > 100 || u.FreeBytes <= 0 || u.InodesFreePct <= 0 {
		t.Fatalf("%+v %v", u, err)
	}
}

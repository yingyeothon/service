// Package capacity answers "may tracer write this many more bytes": the
// stage byte cap over DB + WAL + blobs and the root volume usage line
// (decisions _Debug collector_ #3, docs/tracer.md _Storage_). A periodic
// refresh measures; between refreshes accepted bytes are added to the last
// measurement, so every write is checked against a conservative estimate.
package capacity

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var errNotMeasured = errors.New("capacity: not measured yet")

// Usage is one volume measurement.
type Usage struct {
	UsedPct   int
	FreeBytes int64
	// InodesFreePct is the share of free inodes (100 when the volume does not report inodes).
	InodesFreePct int
}

// MinInodesFreePct refuses writes before blob files could exhaust the inodes
// MariaDB and Valkey share.
const MinInodesFreePct = 10

// Options configures a Capacity.
type Options struct {
	DBPath     string
	DataDir    string
	StageBytes int64
	MaxPct     int
	// BlobBytes sums attachment sizes (store.BlobBytes).
	BlobBytes func(ctx context.Context) (int64, error)
	// Volume measures the volume holding DataDir; nil = statfs.
	Volume func(path string) (Usage, error)
}

// Capacity is safe for concurrent use.
type Capacity struct {
	opt Options

	mu        sync.Mutex
	refreshMu sync.Mutex
	db        int64
	wal       int64
	blobs     int64
	volume    Usage
	err       error
	measured  bool
	added     atomic.Int64
	refresh   time.Time
}

// New builds a Capacity; call Refresh before the first Check.
func New(opt Options) *Capacity {
	if opt.Volume == nil {
		opt.Volume = Statfs
	}
	return &Capacity{opt: opt}
}

// Statfs measures a volume like df: used / (used + available).
func Statfs(path string) (Usage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return Usage{}, err
	}
	bsize := uint64(st.Bsize)
	used := (uint64(st.Blocks) - uint64(st.Bfree)) * bsize
	avail := uint64(st.Bavail) * bsize
	pct := 0
	if used+avail > 0 {
		pct = int((used*100 + used + avail - 1) / (used + avail))
	}
	inodes := 100
	if st.Files > 0 {
		inodes = int(uint64(st.Ffree) * 100 / uint64(st.Files))
	}
	return Usage{UsedPct: pct, FreeBytes: int64(avail), InodesFreePct: inodes}, nil
}

// Refresh measures DB, WAL, blobs and the volume.
func (c *Capacity) Refresh(ctx context.Context) error {
	// One measurement at a time: two overlapping refreshes would both
	// subtract the same addedBefore and under-count.
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	// Bytes added while measuring may or may not be in the measurement; keep
	// them (over-count) rather than lose them.
	addedBefore := c.added.Load()
	db, wal := fileSize(c.opt.DBPath), fileSize(c.opt.DBPath+"-wal")
	var blobs int64
	var err error
	if c.opt.BlobBytes != nil {
		blobs, err = c.opt.BlobBytes(ctx)
	}
	vol, verr := c.opt.Volume(c.opt.DataDir)
	if err == nil {
		err = verr
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.err = err
	if err != nil {
		return err
	}
	c.db, c.wal, c.blobs, c.volume = db, wal, blobs, vol
	c.measured = true
	c.added.Add(-addedBefore)
	c.refresh = time.Now()
	return nil
}

// Snapshot is the last measurement plus bytes accepted since.
type Snapshot struct {
	DBBytes, WALBytes, BlobBytes, AddedBytes int64
	Total                                    int64
	Volume                                   Usage
	Err                                      error
}

// Snapshot reports the current estimate.
func (c *Capacity) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	added := c.added.Load()
	err := c.err
	if err == nil && !c.measured {
		err = errNotMeasured
	}
	return Snapshot{DBBytes: c.db, WALBytes: c.wal, BlobBytes: c.blobs, AddedBytes: added,
		Total: c.db + c.wal + c.blobs + added, Volume: c.volume, Err: err}
}

// Allow reports whether n more bytes fit. A failed measurement refuses: a
// volume tracer cannot see is not one it may fill.
func (c *Capacity) Allow(n int64) bool {
	s := c.Snapshot()
	if s.Err != nil {
		return false
	}
	if s.Volume.UsedPct >= c.opt.MaxPct || s.Volume.InodesFreePct < MinInodesFreePct {
		return false
	}
	return s.Total+n <= c.opt.StageBytes
}

// Add records bytes accepted since the last refresh.
func (c *Capacity) Add(n int64) { c.added.Add(n) }

// Run refreshes every interval until ctx ends.
func (c *Capacity) Run(ctx context.Context, every time.Duration, after func(Snapshot)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.Refresh(ctx)
			if after != nil {
				after(c.Snapshot())
			}
		}
	}
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

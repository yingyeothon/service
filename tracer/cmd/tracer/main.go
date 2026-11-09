// Command tracer is the platform's debug-data collector (docs/tracer.md).
// Configuration is `TRACER_*` environment variables (internal/config).
// Subcommands:
//
//	tracer serve     run the HTTP server
//	tracer version
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yingyeothon/service/tracer/internal/addrlimit"
	"github.com/yingyeothon/service/tracer/internal/capacity"
	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/console"
	"github.com/yingyeothon/service/tracer/internal/ingest"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/query"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/retention"
	"github.com/yingyeothon/service/tracer/internal/server"
	"github.com/yingyeothon/service/tracer/internal/store"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

// devMain is set by dev.go (build tag `dev`): debug-only state hooks that
// never exist in the image (rules/manual-verification.md).
var devMain func(args []string) error

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "version":
		fmt.Println(version)
	case "dev":
		if devMain == nil {
			fmt.Fprintln(os.Stderr, "tracer: dev commands exist only in a -tags dev build")
			os.Exit(2)
		}
		err = devMain(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tracer:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: tracer serve|version   (configuration: TRACER_* environment, see tracer/README.md)")
}

func serve() error {
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel(cfg.LogLevel)}))
	slog.SetDefault(log)
	server.Version = version

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.BlobDir(), 0o700); err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer st.Close()

	reg := metrics.New()
	var (
		src   resource.Source
		auth  query.Authorizer
		ready func(context.Context) (string, bool)
		cons  *console.Client
	)
	if cfg.Mode == config.ModeLocal {
		local := resource.NewLocal(cfg.Local)
		src, auth = local, query.NewLocalAuthorizer(cfg.Local.ReadToken, local)
	} else {
		// Resource config and read authz come from the console's /tr/* routes.
		if cons, err = console.New(console.Options{BaseURL: cfg.ConsoleURL, Token: cfg.Token, Metrics: reg, Log: log}); err != nil {
			return err
		}
		src, auth, ready = cons, cons, cons.Health
		hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if state, ok := cons.Health(hctx); !ok {
			// Not fatal: ingest serves what it can and /healthz reports it.
			log.Warn("console /tr/health is not ok at start", "state", state)
		}
		cancel()
	}
	reg.Gauges.StageBytesCap.Store(cfg.StageBytes)
	// The writer outlives the signal context: it stops only after the HTTP
	// server and the refusal flush are done with it.
	writerCtx, stopWriter := context.WithCancel(context.Background())
	defer stopWriter()
	writer := st.StartWriter(writerCtx)
	if n, err := ingest.SweepTemp(cfg.BlobDir()); err != nil {
		log.Warn("temp blob sweep failed", "err", err)
	} else if n > 0 {
		log.Info("removed temp blob files left by a crash", "count", n)
	}
	capa := capacity.New(capacity.Options{DBPath: cfg.DBPath(), DataDir: cfg.DataDir, StageBytes: cfg.StageBytes,
		MaxPct: cfg.DiskMaxPct, BlobBytes: st.BlobBytes})
	if err := capa.Refresh(ctx); err != nil {
		log.Warn("capacity measurement failed; ingest refuses until it succeeds", "err", err)
	}
	if snap := capa.Snapshot(); snap.Err == nil && snap.Volume.UsedPct >= cfg.DiskMaxPct {
		log.Warn("volume usage is at or above TRACER_DISK_MAX_PCT; every envelope will get 503 (set TRACER_DISK_MAX_PCT=99 for a desktop run)",
			"usedPct", snap.Volume.UsedPct, "maxPct", cfg.DiskMaxPct)
	}
	publishCapacity(reg, capa.Snapshot())
	retOpt := retention.Options{DB: st.DB, DBPath: cfg.DBPath(), BlobDir: cfg.BlobDir(), StageBytes: cfg.StageBytes, Log: log}
	if cons != nil {
		retOpt.Deleted = cons.DeletedIDs
		retOpt.Purged = func(id string) { cons.Forget(id); reg.Forget(id) }
	}
	ret := retention.New(retOpt)
	go ret.Run(ctx, time.Minute, retention.DefaultInterval, func(rep retention.Report) {
		reg.Counters.RetentionRows.Add(rep.AgedRows)
		reg.Counters.RetentionCapRows.Add(rep.CapRows)
		reg.Counters.OrphanBlobs.Add(rep.Orphans)
		reg.Counters.PurgedRows.Add(rep.PurgedRows)
		if rep.PurgeErr != nil {
			reg.Counters.RetentionErrors.Add(1)
		}
		if rep.Err != nil {
			reg.Counters.RetentionErrors.Add(1)
		} else {
			reg.Gauges.RetentionLastOkMs.Store(time.Now().UnixMilli())
		}
		capa.Refresh(ctx) // measure what the pass freed before the next envelope is judged
		publishCapacity(reg, capa.Snapshot())
	})
	go capa.Run(ctx, 30*time.Second, func(s capacity.Snapshot) {
		publishCapacity(reg, s)
		reg.Gauges.WriterTxMaxUs.Store(writer.MaxTxMicros())
		if s.Total*100 > cfg.StageBytes*retention.TriggerPercent {
			ret.Trigger()
		}
	})
	// One failure budget per address across ingest and reads.
	fails := addrlimit.NewFailBuckets(nil)
	ing := ingest.New(ingest.Options{Source: src, Fails: fails, Metrics: reg, Writer: writer, Capacity: capa, DailyBytes: st.DailyBytes,
		BlobDir: cfg.BlobDir(), MaxDecompressed: cfg.MaxEnvelopeBytes, DumpDir: cfg.DumpDir, Log: log})
	ingDone := make(chan struct{})
	go func() { ing.Run(ctx); close(ingDone) }()
	ro, err := store.OpenReadOnly(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer ro.Close()
	read := query.New(query.Options{DB: ro, BlobDir: cfg.BlobDir(), Auth: auth, Fails: fails, Metrics: reg, Log: log})
	var usageDB *sql.DB
	if cfg.Mode != config.ModeLocal {
		usageDB = ro // console GET /tr/usage, operator bearer only
	}
	handler := server.New(server.Options{
		Stage:         cfg.Stage,
		Mode:          cfg.Mode.String(),
		DB:            st,
		Ingest:        ing,
		Read:          read,
		Metrics:       reg,
		Detail:        reg.Detailed,
		OperatorToken: cfg.Token,
		Ready:         ready,
		UsageDB:       usageDB,
		ReadOrigins:   cfg.ReadOrigins,
	})
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info("tracer listening", "addr", cfg.Listen, "mode", cfg.Mode.String(), "stage", cfg.Stage,
		"dataDir", cfg.DataDir, "dump", cfg.DumpDir != "", "version", version)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-ingDone // flushes refusal counters before the writer stops
	stopWriter()
	<-writer.Done()
	return nil
}

func publishCapacity(reg *metrics.Registry, s capacity.Snapshot) {
	reg.Gauges.DBBytes.Store(s.DBBytes)
	reg.Gauges.WALBytes.Store(s.WALBytes)
	reg.Gauges.BlobBytes.Store(s.BlobBytes)
	reg.Gauges.VolumeFreeBytes.Store(s.Volume.FreeBytes)
	reg.Gauges.VolumeUsedPct.Store(int64(s.Volume.UsedPct))
}

func logLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

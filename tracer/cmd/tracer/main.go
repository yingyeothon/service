// Command tracer is the platform's debug-data collector (docs/tracer.md).
// Configuration is `TRACER_*` environment variables (internal/config).
// Subcommands:
//
//	tracer serve     run the HTTP server
//	tracer version
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yingyeothon/service/tracer/internal/config"
	"github.com/yingyeothon/service/tracer/internal/ingest"
	"github.com/yingyeothon/service/tracer/internal/metrics"
	"github.com/yingyeothon/service/tracer/internal/resource"
	"github.com/yingyeothon/service/tracer/internal/server"
	"github.com/yingyeothon/service/tracer/internal/store"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

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
	// Refuse before touching the data dir: opening the store would migrate it.
	if cfg.Mode != config.ModeLocal {
		// todo/85 P5: the console `/tr/*` client.
		return errors.New("server mode (TRACER_CONSOLE_URL) is not implemented yet; run local mode")
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

	var src resource.Source = resource.NewLocal(cfg.Local)
	reg := metrics.New()
	reg.Gauges.StageBytesCap.Store(cfg.StageBytes)
	handler := server.New(server.Options{
		Stage:         cfg.Stage,
		Mode:          cfg.Mode.String(),
		DB:            st,
		Ingest:        ingest.New(ingest.Options{Source: src, Metrics: reg, MaxBodyBytes: cfg.MaxEnvelopeBytes, DumpDir: cfg.DumpDir, Log: log}),
		Metrics:       reg,
		Detail:        reg.Detailed,
		OperatorToken: cfg.Token,
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
	return nil
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

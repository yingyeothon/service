// Command gateway is the yyt realtime WebSocket gateway (`lobby`/`q`
// strategies). Configuration is `GATEWAY_*` environment variables; see
// gateway/README.md.
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

	"github.com/yingyeothon/service/gateway/internal/authn"
	"github.com/yingyeothon/service/gateway/internal/config"
	"github.com/yingyeothon/service/gateway/internal/conn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/metrics"
	"github.com/yingyeothon/service/gateway/internal/redisx"
	"github.com/yingyeothon/service/gateway/internal/server"

	"github.com/redis/go-redis/v9"
)

// redisLogger routes go-redis' own lines ("discarding bad PubSub
// connection", …) into the JSON log instead of bare stderr.
type redisLogger struct{ log *slog.Logger }

func (l redisLogger) Printf(_ context.Context, format string, v ...any) {
	l.log.Warn("go-redis: " + fmt.Sprintf(format, v...))
}

func main() {
	if err := run(); err != nil {
		slog.Error("gateway exited", "err", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		return err
	}
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.LogLevel))
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	redis.SetLogger(redisLogger{log: log})
	reg := metrics.New()
	rdb, err := redisx.Open(ctx, cfg.RedisURL, cfg.Stage)
	if err != nil {
		return err
	}
	defer rdb.Close()

	cons := console.New(console.Options{BaseURL: cfg.ConsoleURL, Token: cfg.Token, TTL: cfg.ConfigTTL, Logger: log,
		OnFetch: func() { reg.Counters.ConfigFetches.Add(1) }})
	if configured, err := cons.Health(ctx); err != nil {
		// Not fatal: the console may be mid-deploy. /healthz keeps reporting it.
		log.Warn("console health probe failed", "err", err.Error())
	} else if !configured {
		log.Error("console has no gateway token configured; every connect will be refused")
	}
	verifier := authn.New(authn.Options{Logger: log,
		OnCall: func() { reg.Counters.VerifyCalls.Add(1) },
		OnHit:  func() { reg.Counters.VerifyCacheHits.Add(1) }})

	srv := server.New(server.Options{Stage: cfg.Stage, Console: cons, Verifier: verifier, Redis: rdb, Registry: reg,
		Logger: log, ConfigTTL: cfg.ConfigTTL, Limits: conn.DefaultLimits(), MaxConnections: cfg.MaxConnections, OperatorToken: cfg.Token})
	httpSrv := &http.Server{Addr: cfg.Listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	errc := make(chan error, 1)
	go func() {
		var err error
		if cfg.TLSCert != "" {
			err = httpSrv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			err = httpSrv.ListenAndServe()
		}
		if !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	log.Info("gateway listening", "addr", cfg.Listen, "stage", cfg.Stage, "version", server.Version, "tls", cfg.TLSCert != "")

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down", "timeout", cfg.ShutdownTimeout.String())
	dctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	// Readiness flips first so a proxy stops routing handshakes, then the
	// sockets drain, then the listener closes.
	srv.Draining()
	if err := srv.Shutdown(dctx); err != nil {
		log.Warn("drain incomplete", "err", err.Error())
	}
	_ = httpSrv.Shutdown(dctx)
	return nil
}

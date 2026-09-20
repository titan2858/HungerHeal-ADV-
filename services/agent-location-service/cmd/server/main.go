package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hungerheal/agent-location-service/internal/api"
	"hungerheal/agent-location-service/internal/authclient"
	"hungerheal/agent-location-service/internal/config"
	"hungerheal/agent-location-service/internal/httpx"
	"hungerheal/agent-location-service/internal/logging"
	"hungerheal/agent-location-service/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		// Before the logger exists, so plain stderr. Failing at boot with a
		// clear reason beats starting and rejecting every request later.
		println("[agent-location-service] invalid configuration: " + err.Error())
		os.Exit(1)
	}

	logger := logging.New(cfg.LogLevel, cfg.ServiceName)

	st, err := store.New(cfg.RedisURL, cfg.AgentTTL)
	if err != nil {
		logger.Error("could not create redis client", "err", err.Error())
		os.Exit(1)
	}
	defer st.Close()

	// Redis is not optional for this service the way it is for geocoding: there
	// is nowhere else to put a live location. Fail loudly at startup.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := st.Ping(ctx); err != nil {
		cancel()
		logger.Error("redis unreachable at startup", "err", err.Error(), "url", cfg.RedisURL)
		os.Exit(1)
	}
	cancel()

	handlers := &api.Handlers{
		Store:   st,
		Auth:    authclient.New(cfg.AuthServiceURL, cfg.AuthTimeout),
		Logger:  logger,
		Service: cfg.ServiceName,
	}

	handler := httpx.Chain(
		httpx.Recover(logger),
		httpx.Trace(logger),
	)(api.Routes(handlers, cfg.JWTSecret))

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: handler,
		// Without these a single slow or stalled client can hold a connection
		// open indefinitely.
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// The reaper runs in its own goroutine for the whole life of the process.
	// This is the cheap version of a background worker - no scheduler, no cron
	// container, just a ticker in a goroutine, which is exactly the kind of
	// thing Go makes unremarkable.
	reaperCtx, stopReaper := context.WithCancel(context.Background())
	go runReaper(reaperCtx, st, cfg.ReapInterval, logger)

	go func() {
		logger.Info("agent-location-service listening",
			"port", cfg.Port,
			"agentTtlSeconds", int(cfg.AgentTTL.Seconds()),
			"reapIntervalSeconds", int(cfg.ReapInterval.Seconds()))

		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "err", err.Error())
			os.Exit(1)
		}
	}()

	// Graceful shutdown: `docker compose down` sends SIGTERM, and without this
	// in-flight location reports would be cut off mid-write.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit

	logger.Info("shutting down", "signal", sig.String())
	stopReaper()

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown failed", "err", err.Error())
	}
	logger.Info("stopped")
}

// runReaper periodically clears out geo-set entries whose heartbeat has
// expired.
//
// Reads already skip stale agents, so this is not what keeps matching correct -
// it keeps the geo set from accumulating every agent who has ever used the app,
// which would make every GEOSEARCH scan more members and hold memory forever.
func runReaper(ctx context.Context, st *store.Store, interval time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Info("reaper stopped")
			return
		case <-ticker.C:
			reapCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			removed, err := st.Reap(reapCtx)
			cancel()

			if err != nil {
				logger.Warn("reap failed", "err", err.Error())
				continue
			}
			if removed > 0 {
				logger.Info("reaped stale agent locations", "removed", removed)
			}
		}
	}
}

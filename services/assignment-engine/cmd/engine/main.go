package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hungerheal/assignment-engine/internal/candidates"
	"hungerheal/assignment-engine/internal/config"
	"hungerheal/assignment-engine/internal/engine"
	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/logging"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		println("[assignment-engine] invalid configuration: " + err.Error())
		os.Exit(1)
	}

	logger := logging.New(cfg.LogLevel, cfg.ServiceName)

	finder, err := candidates.NewFinder(cfg.RedisURL)
	if err != nil {
		logger.Error("could not create redis client", "err", err.Error())
		os.Exit(1)
	}
	defer finder.Close()

	// Redis is not optional: without it there is no way to find any agent, and
	// every donation would fail. Better to refuse to start than to consume
	// events and drop them all.
	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	if err := finder.Ping(pingCtx); err != nil {
		cancelPing()
		logger.Error("redis unreachable at startup", "err", err.Error())
		os.Exit(1)
	}
	cancelPing()

	producer := events.NewProducer(cfg.KafkaBrokers)
	defer producer.Close()

	consumer := events.NewConsumer(cfg.KafkaBrokers, cfg.ConsumerGroup, events.TopicDonationCreated)
	defer consumer.Close()

	eng := &engine.Engine{
		Candidates:     finder,
		Publisher:      producer,
		Logger:         logger,
		OfferBatchSize: cfg.OfferBatchSize,
		MaxCandidates:  cfg.MaxCandidates,
	}

	// This service is event-driven, not request-driven. The HTTP server exists
	// only so Docker has something to health-check and so the matching state is
	// inspectable while debugging.
	healthServer := startHealthServer(cfg, finder, logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("assignment-engine started",
		"brokers", cfg.KafkaBrokers,
		"consumerGroup", cfg.ConsumerGroup,
		"topic", events.TopicDonationCreated,
		"offerBatchSize", cfg.OfferBatchSize)

	runConsumeLoop(ctx, consumer, eng, logger)

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	_ = healthServer.Shutdown(shutdownCtx)
	logger.Info("stopped")
}

// runConsumeLoop is the heart of the service: fetch, process, commit.
//
// The order matters. The offset is committed only AFTER the work succeeded, so
// a crash mid-processing means the message is redelivered rather than lost.
// That is at-least-once delivery working as designed - and is precisely why
// consumers must be made idempotent in Phase 6.
func runConsumeLoop(ctx context.Context, consumer *events.Consumer, eng *engine.Engine, logger *slog.Logger) {
	for {
		msg, err := consumer.Fetch(ctx)
		if err != nil {
			// A cancelled context is a clean shutdown, not a failure.
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("could not fetch from kafka", "err", err.Error())
			// Back off rather than spinning hot against a broker that is down.
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}

		handleMessage(ctx, consumer, eng, logger, msg)
	}
}

func handleMessage(ctx context.Context, consumer *events.Consumer, eng *engine.Engine, logger *slog.Logger, msg *events.Message) {
	var evt events.DonationCreated
	if err := json.Unmarshal(msg.Value, &evt); err != nil {
		// A message that cannot be parsed will never parse, however many times
		// it is retried. Leaving it uncommitted would block this partition
		// forever - the classic "poison message" stall - so it is committed and
		// logged loudly.
		//
		// The proper answer is a dead-letter topic to hold it for inspection
		// instead of discarding it. Noted as a gap rather than pretended away.
		logger.Error("discarding unparseable message",
			"err", err.Error(), "key", msg.Key, "bytes", len(msg.Value))
		_ = consumer.Commit(ctx, msg)
		return
	}

	// The traceId rides in from donation-service, so this scoring run appears
	// under the same trace as the donor's original HTTP request.
	traceID := evt.TraceID
	if traceID == "" {
		traceID = msg.Headers["x-trace-id"]
	}
	msgCtx := logging.WithTrace(ctx, traceID)

	// A per-message timeout, so one pathological donation cannot wedge the
	// whole partition.
	workCtx, cancel := context.WithTimeout(msgCtx, 30*time.Second)
	_, err := eng.Handle(workCtx, evt)
	cancel()

	if err != nil {
		// NOT committed on purpose: Redis or Kafka failed, the donation is
		// still placeable, and it will be redelivered.
		logging.FromContext(msgCtx, logger).Error("could not process donation",
			"donationId", evt.DonationID, "err", err.Error())
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
		return
	}

	if err := consumer.Commit(ctx, msg); err != nil {
		// The work is done but the offset did not advance, so this donation
		// will be reprocessed - another reason Phase 6's dedup matters.
		logging.FromContext(msgCtx, logger).Error("could not commit offset",
			"donationId", evt.DonationID, "err", err.Error())
	}
}

func startHealthServer(cfg config.Config, finder *candidates.Finder, logger *slog.Logger) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status": "ok", "service": cfg.ServiceName,
		})
	})

	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		agents, err := finder.Stats(ctx)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status":       "not-ready",
				"dependencies": map[string]string{"redis": "down"},
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "ready",
			"dependencies":  map[string]string{"redis": "up"},
			"agentsTracked": agents,
			"consumerGroup": cfg.ConsumerGroup,
		})
	})

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("health server failed", "err", err.Error())
		}
	}()

	return server
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

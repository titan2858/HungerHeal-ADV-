package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"hungerheal/assignment-engine/internal/api"
	"hungerheal/assignment-engine/internal/candidates"
	"hungerheal/assignment-engine/internal/config"
	"hungerheal/assignment-engine/internal/engine"
	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/httpx"
	"hungerheal/assignment-engine/internal/logging"
	"hungerheal/assignment-engine/internal/offers"
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

	// Redis is not optional: without it there is no way to find any agent, no
	// deadlines, and no claim lock. Refusing to start beats consuming events
	// and dropping every one of them.
	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	if err := finder.Ping(pingCtx); err != nil {
		cancelPing()
		logger.Error("redis unreachable at startup", "err", err.Error())
		os.Exit(1)
	}
	cancelPing()

	offerStore := offers.New(finder.Client(), cfg.DedupTTL)

	producer := events.NewProducer(cfg.KafkaBrokers)
	defer producer.Close()

	eng := &engine.Engine{
		Candidates:     finder,
		Publisher:      producer,
		Offers:         offerStore,
		Logger:         logger,
		OfferBatchSize: cfg.OfferBatchSize,
		MaxCandidates:  cfg.MaxCandidates,
		MaxRounds:      cfg.MaxRounds,
		StateTTL:       cfg.StateTTL,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup

	// -------------------------------------------------- the deadline watcher
	// This is what makes the response window real. Without it, an offer nobody
	// answers simply sits there and the donation never moves.
	watcher := &engine.Watcher{
		Store:     offerStore,
		Publisher: producer,
		Logger:    logger,
		Interval:  cfg.WatchInterval,
		BatchSize: cfg.WatchBatchSize,
	}
	wg.Add(1)
	go func() { defer wg.Done(); watcher.Run(ctx) }()

	// ------------------------------------------------------- two consumers
	// Separate consumer instances for the two topics, in the SAME group. Each
	// runs in its own goroutine, so a slow re-score cannot hold up a brand-new
	// donation - which matters, since a re-score is by definition already late.
	createdConsumer := events.NewConsumer(cfg.KafkaBrokers, cfg.ConsumerGroup, events.TopicDonationCreated)
	defer createdConsumer.Close()

	timeoutConsumer := events.NewConsumer(cfg.KafkaBrokers, cfg.ConsumerGroup, events.TopicDonationTimeout)
	defer timeoutConsumer.Close()

	wg.Add(1)
	go func() {
		defer wg.Done()
		consume(ctx, createdConsumer, offerStore, logger, "donation.created",
			func(c context.Context, raw []byte) (string, string, error) {
				var evt events.DonationCreated
				if err := json.Unmarshal(raw, &evt); err != nil {
					return "", "", err
				}
				_, err := eng.Handle(c, evt)
				return evt.EventID, evt.TraceID, err
			})
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		consume(ctx, timeoutConsumer, offerStore, logger, "donation.timeout",
			func(c context.Context, raw []byte) (string, string, error) {
				var evt events.DonationTimeout
				if err := json.Unmarshal(raw, &evt); err != nil {
					return "", "", err
				}
				_, err := eng.HandleTimeout(c, evt)
				return evt.EventID, evt.TraceID, err
			})
	}()

	// --------------------------------------------------------- the HTTP API
	server := startServer(cfg, eng, finder, offerStore, logger)

	logger.Info("assignment-engine started",
		"brokers", cfg.KafkaBrokers,
		"consumerGroup", cfg.ConsumerGroup,
		"offerBatchSize", cfg.OfferBatchSize,
		"maxRounds", cfg.MaxRounds,
		"watchIntervalSeconds", cfg.WatchInterval.Seconds())

	<-ctx.Done()

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	wg.Wait()
	logger.Info("stopped")
}

// eventIDFrom pulls just the eventId out of a raw event, without committing to
// a full decode - the concrete event type is not known at this point, and every
// HungerHeal event carries this field in the same place.
func eventIDFrom(raw []byte) string {
	var envelope struct {
		EventID string `json:"eventId"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return ""
	}
	return envelope.EventID
}

func traceIDFrom(raw []byte) string {
	var envelope struct {
		TraceID string `json:"traceId"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return ""
	}
	return envelope.TraceID
}

// handlerFunc processes one message and returns its eventId and traceId so the
// caller can deduplicate and log under the right trace.
type handlerFunc func(ctx context.Context, raw []byte) (eventID, traceID string, err error)

// consume is the shared fetch/dedup/process/commit loop for both topics.
func consume(
	ctx context.Context,
	consumer *events.Consumer,
	store *offers.Store,
	logger *slog.Logger,
	topic string,
	handle handlerFunc,
) {
	log := logger.With("topic", topic)
	log.Info("consumer started")

	for {
		msg, err := consumer.Fetch(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				log.Info("consumer stopped")
				return
			}
			log.Error("could not fetch from kafka", "err", err.Error())
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}

		processMessage(ctx, consumer, store, log, msg, handle)
	}
}

func processMessage(
	ctx context.Context,
	consumer *events.Consumer,
	store *offers.Store,
	log *slog.Logger,
	msg *events.Message,
	handle handlerFunc,
) {
	// The event id is needed for the dedup check BEFORE the work runs.
	//
	// It is read from the BODY, with the header only as a fallback. Headers are
	// the convenient place to look, but they are not guaranteed to survive
	// every path a message can take into a topic - a replay through a console
	// producer, a mirroring tool, or a hand-crafted message can all arrive
	// without them. Losing the header would silently disable deduplication and
	// let a donation be assigned twice, which is exactly the failure this check
	// exists to prevent. The body always carries eventId, so the body wins.
	eventID := eventIDFrom(msg.Value)
	if eventID == "" {
		eventID = msg.Headers["x-event-id"]
	}

	traceID := msg.Headers["x-trace-id"]
	if traceID == "" {
		traceID = traceIDFrom(msg.Value)
	}
	msgCtx := logging.WithTrace(ctx, traceID)
	tlog := logging.FromContext(msgCtx, log)

	// ------------------------------------------------------ IDEMPOTENCY
	// Kafka delivers at least once. A consumer that crashes after doing its
	// work but before committing its offset sees this exact message again on
	// restart - and without this check the engine would score the donation
	// twice and publish two donation.assigned events, so six agents get
	// notified for one meal and two of them drive to the same door.
	fresh, err := store.BeginProcessing(msgCtx, eventID)
	if err != nil {
		tlog.Error("dedup check failed; not committing", "err", err.Error())
		time.Sleep(time.Second)
		return
	}
	if !fresh {
		tlog.Info("skipping an event that has already been processed", "eventId", eventID)
		// Committed, because the work IS done - just not by this delivery.
		_ = consumer.Commit(ctx, msg)
		return
	}

	workCtx, cancel := context.WithTimeout(msgCtx, 30*time.Second)
	_, _, err = handle(workCtx, msg.Value)
	cancel()

	if err != nil {
		// The dedup marker was set BEFORE the work. Leaving it would make the
		// redelivery skip a donation that never actually got processed - losing
		// it precisely when the system is already having a bad day.
		if relErr := store.AbandonProcessing(msgCtx, eventID); relErr != nil {
			tlog.Error("could not release the dedup marker", "err", relErr.Error())
		}

		tlog.Error("could not process event; leaving it uncommitted for retry", "err", err.Error())
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
		return
	}

	if err := consumer.Commit(ctx, msg); err != nil {
		// The work succeeded but the offset did not advance, so this event will
		// be redelivered - and the dedup marker above is what makes that
		// harmless rather than a double assignment.
		tlog.Error("could not commit offset", "err", err.Error())
	}
}

func startServer(
	cfg config.Config,
	eng *engine.Engine,
	finder *candidates.Finder,
	store *offers.Store,
	logger *slog.Logger,
) *http.Server {
	handlers := &api.Handlers{Engine: eng, Logger: logger}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok", "service": cfg.ServiceName})
	})

	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		agents, err := finder.Stats(ctx)
		if err != nil {
			httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "not-ready", "dependencies": map[string]string{"redis": "down"},
			})
			return
		}

		pending, _ := store.DueNow(ctx, time.Now().UTC().Add(24*time.Hour), 1000)

		httpx.JSON(w, http.StatusOK, map[string]any{
			"status":        "ready",
			"dependencies":  map[string]string{"redis": "up"},
			"agentsTracked": agents,
			// Offers currently waiting on a response, so the matching state is
			// visible without reading Redis by hand.
			"offersAwaitingResponse": len(pending),
			"consumerGroup":          cfg.ConsumerGroup,
		})
	})

	// Only agents answer offers, and the id always comes from the token.
	agentOnly := httpx.Chain(httpx.RequireAuth(cfg.JWTSecret), httpx.RequireRole("AGENT"))

	mux.Handle("POST /offers/{donationId}/accept", agentOnly(http.HandlerFunc(handlers.Accept)))
	mux.Handle("POST /offers/{donationId}/reject", agentOnly(http.HandlerFunc(handlers.Reject)))
	mux.Handle("GET /offers/{donationId}", agentOnly(http.HandlerFunc(handlers.Offer)))

	handler := httpx.Chain(httpx.Recover(logger), httpx.Trace(logger))(mux)

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      handler,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", "err", err.Error())
		}
	}()

	return server
}

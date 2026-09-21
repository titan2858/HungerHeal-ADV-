package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ServiceName string
	Env         string
	Port        string // health endpoint only; this service is event-driven

	RedisURL string

	// Agents answer offers over HTTP, so this service verifies tokens too.
	// Must match auth-service byte for byte.
	JWTSecret string

	KafkaBrokers  []string
	ConsumerGroup string

	// How many agents are offered a donation at once. The plan says 3: enough
	// that one distracted agent does not stall the donation, few enough that
	// two thirds of offers are not wasted notifications every single time.
	OfferBatchSize int

	// Hard cap on candidates pulled from Redis per radius step, so one dense
	// city centre cannot make a single donation score thousands of agents.
	MaxCandidates int

	// How often the watcher looks for offers whose window has closed. Well
	// under the 90s shortest timeout, so an expiry is acted on promptly rather
	// than adding a whole poll interval to the food's waiting time.
	WatchInterval time.Duration

	// How many expired offers one sweep handles.
	WatchBatchSize int64

	// How long a processed-event marker is kept. Comfortably longer than any
	// plausible redelivery window, and short enough that the keys do not
	// accumulate forever.
	DedupTTL time.Duration

	// How long offer state outlives its deadline, so a late accept gets a
	// meaningful answer rather than a bare 404.
	StateTTL time.Duration

	// Cap on re-offer rounds before the donor is told nobody took it.
	MaxRounds int

	LogLevel string

	ShutdownGrace time.Duration
}

func Load() (Config, error) {
	c := Config{
		ServiceName:   get("SERVICE_NAME", "assignment-engine"),
		Env:           get("NODE_ENV", "development"),
		Port:          get("PORT", "4005"),
		RedisURL:      get("REDIS_URL", "redis://localhost:6379"),
		ConsumerGroup: get("KAFKA_CONSUMER_GROUP", "assignment-engine"),
		JWTSecret:     get("JWT_SECRET", ""),
		LogLevel:      get("LOG_LEVEL", "info"),
		ShutdownGrace: 15 * time.Second,
		DedupTTL:      24 * time.Hour,
		StateTTL:      6 * time.Hour,
	}

	if len(c.JWTSecret) < 16 {
		return c, fmt.Errorf("JWT_SECRET must be at least 16 characters (got %d)", len(c.JWTSecret))
	}

	brokers := get("KAFKA_BROKERS", "localhost:29092")
	for _, b := range strings.Split(brokers, ",") {
		if trimmed := strings.TrimSpace(b); trimmed != "" {
			c.KafkaBrokers = append(c.KafkaBrokers, trimmed)
		}
	}
	if len(c.KafkaBrokers) == 0 {
		return c, fmt.Errorf("KAFKA_BROKERS must list at least one broker")
	}

	var err error
	if c.OfferBatchSize, err = positiveInt("OFFER_BATCH_SIZE", 3); err != nil {
		return c, err
	}
	if c.MaxCandidates, err = positiveInt("MAX_CANDIDATES", 100); err != nil {
		return c, err
	}
	if c.MaxRounds, err = positiveInt("MAX_OFFER_ROUNDS", 4); err != nil {
		return c, err
	}

	watchSeconds, err := positiveInt("WATCH_INTERVAL_SECONDS", 5)
	if err != nil {
		return c, err
	}
	c.WatchInterval = time.Duration(watchSeconds) * time.Second

	batch, err := positiveInt("WATCH_BATCH_SIZE", 100)
	if err != nil {
		return c, err
	}
	c.WatchBatchSize = int64(batch)

	return c, nil
}

func get(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func positiveInt(key string, fallback int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer, got %q", key, raw)
	}
	return n, nil
}

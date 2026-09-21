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

	KafkaBrokers  []string
	ConsumerGroup string

	// How many agents are offered a donation at once. The plan says 3: enough
	// that one distracted agent does not stall the donation, few enough that
	// two thirds of offers are not wasted notifications every single time.
	OfferBatchSize int

	// Hard cap on candidates pulled from Redis per radius step, so one dense
	// city centre cannot make a single donation score thousands of agents.
	MaxCandidates int

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
		LogLevel:      get("LOG_LEVEL", "info"),
		ShutdownGrace: 15 * time.Second,
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

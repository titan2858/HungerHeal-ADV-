package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is validated once at boot; the process refuses to start if anything is
// wrong. A service that starts happily with a missing JWT secret and only fails
// on the first request is far harder to diagnose than one that says why.
type Config struct {
	Port        string
	ServiceName string
	Env         string

	RedisURL  string
	JWTSecret string

	// Where to fetch an agent's capabilities from the first time it reports a
	// location. auth-service owns that data.
	AuthServiceURL string
	AuthTimeout    time.Duration

	// How long a location stays trusted without a fresh heartbeat.
	//
	// This exists because of a real Redis constraint: a geo set is a sorted set,
	// and sorted-set MEMBERS cannot individually expire. Only whole keys have
	// TTLs. So presence is tracked by a separate per-agent key that does expire,
	// and stale entries are swept out of the geo set by the reaper below.
	AgentTTL time.Duration

	// How often the reaper removes geo-set entries whose heartbeat has expired.
	ReapInterval time.Duration

	LogLevel string
}

func Load() (Config, error) {
	c := Config{
		Port:           get("PORT", "4004"),
		ServiceName:    get("SERVICE_NAME", "agent-location-service"),
		Env:            get("NODE_ENV", "development"),
		RedisURL:       get("REDIS_URL", "redis://localhost:6379"),
		JWTSecret:      get("JWT_SECRET", ""),
		AuthServiceURL: get("AUTH_SERVICE_URL", "http://localhost:4001"),
		LogLevel:       get("LOG_LEVEL", "info"),
	}

	var err error
	if c.AgentTTL, err = duration("AGENT_TTL_SECONDS", 120); err != nil {
		return c, err
	}
	if c.ReapInterval, err = duration("REAP_INTERVAL_SECONDS", 60); err != nil {
		return c, err
	}
	if c.AuthTimeout, err = duration("AUTH_TIMEOUT_SECONDS", 5); err != nil {
		return c, err
	}

	// Must match auth-service byte for byte, or every token it issues is
	// rejected here.
	if len(c.JWTSecret) < 16 {
		return c, fmt.Errorf("JWT_SECRET must be at least 16 characters (got %d)", len(c.JWTSecret))
	}

	return c, nil
}

func get(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func duration(key string, fallbackSeconds int) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return time.Duration(fallbackSeconds) * time.Second, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive number of seconds, got %q", key, raw)
	}
	return time.Duration(n) * time.Second, nil
}

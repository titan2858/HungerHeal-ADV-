package logging

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

// Structured JSON logs carrying a traceId, matching what the Node services
// emit, so `docker compose logs | grep <traceId>` follows one donation across
// services written in two different languages.

type ctxKey string

const traceKey ctxKey = "traceId"

func New(level, service string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error", "fatal":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	return slog.New(handler).With("service", service)
}

// WithTrace stores the request's traceId on the context so handlers deeper in
// the stack can log under it without it being threaded through every signature.
func WithTrace(ctx context.Context, traceID string) context.Context {
	return context.WithValue(ctx, traceKey, traceID)
}

func TraceFrom(ctx context.Context) string {
	if v, ok := ctx.Value(traceKey).(string); ok {
		return v
	}
	return ""
}

// FromContext returns a logger already bound to the context's traceId.
func FromContext(ctx context.Context, base *slog.Logger) *slog.Logger {
	if t := TraceFrom(ctx); t != "" {
		return base.With("traceId", t)
	}
	return base
}

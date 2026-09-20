package api

import (
	"net/http"

	"hungerheal/agent-location-service/internal/httpx"
)

// Routes uses Go's standard ServeMux with method+path patterns (Go 1.22+), so
// no third-party router is needed. Fewer dependencies is not just tidiness
// here: it keeps the container small and the upgrade surface minimal for a
// service whose job is two Redis writes.
func Routes(h *Handlers, jwtSecret string) http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated: used by Docker's healthcheck, which has no token.
	mux.HandleFunc("GET /health", h.Health)
	mux.HandleFunc("GET /ready", h.Ready)

	authOnly := httpx.RequireAuth(jwtSecret)
	agentOnly := httpx.Chain(httpx.RequireAuth(jwtSecret), httpx.RequireRole("AGENT"))

	// Agents report their own position; the id comes from the token, never the
	// body, so one agent cannot move another agent's pin.
	mux.Handle("POST /agents/location", agentOnly(http.HandlerFunc(h.UpdateLocation)))
	mux.Handle("POST /agents/offline", agentOnly(http.HandlerFunc(h.GoOffline)))
	mux.Handle("POST /agents/availability", agentOnly(http.HandlerFunc(h.SetAvailability)))
	mux.Handle("GET /agents/me", agentOnly(http.HandlerFunc(h.Me)))

	// Any authenticated caller can run a radius search. This is what
	// assignment-engine's query looks like, exposed for inspection.
	mux.Handle("GET /agents/nearby", authOnly(http.HandlerFunc(h.Nearby)))

	// Temporary until tracking-service drives load from Kafka events (Phase 7).
	mux.Handle("POST /agents/{agentId}/load", authOnly(http.HandlerFunc(h.AdjustLoad)))

	return mux
}

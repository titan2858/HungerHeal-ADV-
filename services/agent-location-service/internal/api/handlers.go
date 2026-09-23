package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"hungerheal/agent-location-service/internal/authclient"
	"hungerheal/agent-location-service/internal/domain"
	"hungerheal/agent-location-service/internal/httpx"
	"hungerheal/agent-location-service/internal/logging"
	"hungerheal/agent-location-service/internal/store"
)

type Handlers struct {
	Store   *store.Store
	Auth    *authclient.Client
	Logger  *slog.Logger
	Service string
}

// ------------------------------------------------------------------ health

func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": h.Service,
	})
}

// Ready checks Redis, which this service genuinely cannot work without: there
// is nowhere else to put a location. Unlike the caching in geocoding-service,
// Redis here is the system of record for live position, so a Redis outage is a
// real not-ready.
func (h *Handlers) Ready(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if err := h.Store.Ping(ctx); err != nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"status":       "not-ready",
			"dependencies": map[string]string{"redis": "down"},
		})
		return
	}

	online, _ := h.Store.CountOnline(ctx)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":        "ready",
		"dependencies":  map[string]string{"redis": "up"},
		"agentsTracked": online,
	})
}

// ------------------------------------------------------- capability mirror

// ensureCapabilities makes sure a COMPLETE capability record exists in Redis
// before anything else touches this agent's state.
//
// Called from every endpoint that can be an agent's first contact, not just
// the location report. Ordering used to matter and must not: the UI shows the
// availability toggle as soon as a shift starts, which is before the browser
// has produced a GPS fix, so `POST /agents/availability` can genuinely arrive
// first. When it did, its HSET created the caps hash, the location report
// concluded capabilities were already on record, and the mirror never ran -
// leaving an agent with no categories, which the matching engine treats as a
// hard exclusion from every donation however close they are.
func (h *Handlers) ensureCapabilities(ctx context.Context, r *http.Request, user httpx.User) error {
	log := logging.FromContext(ctx, h.Logger)

	known, err := h.Store.HasCapabilities(ctx, user.ID)
	if err != nil {
		return err
	}
	if known {
		return nil
	}

	agent, err := h.Auth.FetchAgent(ctx, r.Header.Get("Authorization"), logging.TraceFrom(ctx))
	if err != nil {
		// Falls back to what the token already carries rather than rejecting
		// the request. An agent's position is time-sensitive, and dropping it
		// because auth-service was briefly slow would take a working agent out
		// of matching entirely.
		//
		// Saved WITHOUT the completeness sentinel, so the next request tries
		// again. The token carries no categories, and a record that claimed to
		// be a finished mirror while holding none would leave the agent
		// hard-filtered out of every donation until something deleted the key.
		log.Warn("could not fetch capabilities, storing minimal profile", "err", err.Error())
		partial := domain.Agent{
			AgentID: user.ID,
			Name:    user.Name,
			Phone:   user.Phone,
			Rating:  3.5,
		}
		if err := h.Store.SavePartialProfile(ctx, user.ID, partial); err != nil {
			return err
		}
		return nil
	}

	if err := h.Store.SaveCapabilities(ctx, user.ID, *agent); err != nil {
		return err
	}

	log.Info("agent capabilities mirrored into redis",
		"agentId", user.ID,
		"categories", agent.Capabilities.CategoriesHandled)
	return nil
}

// -------------------------------------------------------------- location

type locationRequest struct {
	Lat *float64 `json:"lat"`
	Lng *float64 `json:"lng"`
}

// UpdateLocation is the endpoint an agent's device calls repeatedly while they
// are on shift - roughly every 15-30 seconds.
//
// It is deliberately the cheapest thing in the system: two Redis writes in one
// pipeline. It is called far more often than anything else here, by every
// active agent simultaneously, which is much of why this service is in Go.
func (h *Handlers) UpdateLocation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := logging.FromContext(ctx, h.Logger)

	user, _ := httpx.UserFrom(ctx)

	var req locationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.BadRequest(w, r, "body must be JSON with lat and lng")
		return
	}

	// Pointers, not plain float64s, specifically so a missing field can be told
	// apart from a legitimate 0. Longitude 0 is the Greenwich meridian, and
	// latitude 0 is the equator - both real places.
	if req.Lat == nil || req.Lng == nil {
		httpx.BadRequest(w, r, "both lat and lng are required")
		return
	}
	if err := validateCoordinates(*req.Lat, *req.Lng); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	// First contact from this agent: mirror their capabilities from
	// auth-service so the matching hot path can read everything from Redis.
	if err := h.ensureCapabilities(ctx, r, user); err != nil {
		log.Error("could not mirror capabilities", "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	if err := h.Store.UpsertLocation(ctx, user.ID, *req.Lat, *req.Lng); err != nil {
		log.Error("could not store location", "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	log.Debug("location updated", "agentId", user.ID, "lat", *req.Lat, "lng", *req.Lng)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"agentId": user.ID,
		"lat":     *req.Lat,
		"lng":     *req.Lng,
		// Telling the client when the heartbeat lapses lets it choose its own
		// reporting interval rather than guessing.
		"expiresInSeconds": int(h.Store.TTL().Seconds()),
	})
}

// GoOffline removes the agent from matching immediately, instead of waiting out
// the heartbeat. Called when an agent ends their shift.
func (h *Handlers) GoOffline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user, _ := httpx.UserFrom(ctx)

	if err := h.Store.GoOffline(ctx, user.ID); err != nil {
		logging.FromContext(ctx, h.Logger).Error("could not go offline", "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"agentId": user.ID, "online": false})
}

type availabilityRequest struct {
	Available *bool `json:"available"`
}

// SetAvailability toggles whether the agent accepts new work while staying
// online. Distinct from going offline: a driver finishing their last delivery
// still wants their position tracked.
func (h *Handlers) SetAvailability(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user, _ := httpx.UserFrom(ctx)

	var req availabilityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Available == nil {
		httpx.BadRequest(w, r, "body must be JSON with an `available` boolean")
		return
	}

	// Before the toggle, not after. This can be an agent's first contact - the
	// shift panel offers the toggle while the browser is still acquiring a GPS
	// fix - and SetAvailability's HSET would otherwise create a caps hash that
	// looked like a record but carried no categories.
	if err := h.ensureCapabilities(ctx, r, user); err != nil {
		logging.FromContext(ctx, h.Logger).Error("could not mirror capabilities", "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	if err := h.Store.SetAvailability(ctx, user.ID, *req.Available); err != nil {
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"agentId":   user.ID,
		"available": *req.Available,
	})
}

// Me returns everything currently stored about the calling agent.
func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user, _ := httpx.UserFrom(ctx)

	agent, err := h.Store.GetAgent(ctx, user.ID)
	if err != nil {
		httpx.Internal(w, r)
		return
	}
	if agent == nil {
		httpx.NotFound(w, r, "no location on record - report a location first")
		return
	}

	online, _ := h.Store.IsOnline(ctx, user.ID)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"agent":  agent,
		"online": online,
	})
}

// -------------------------------------------------------------- discovery

// Nearby is the query assignment-engine will run on every donation in Phase 5.
//
// It is exposed over HTTP mainly so the matching can be inspected and debugged
// by hand - the engine itself will run the same GEOSEARCH against Redis
// directly, since going through another service's HTTP layer on the hot path
// would add latency for nothing.
func (h *Handlers) Nearby(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	lat, errLat := strconv.ParseFloat(q.Get("lat"), 64)
	lng, errLng := strconv.ParseFloat(q.Get("lng"), 64)
	if errLat != nil || errLng != nil {
		httpx.BadRequest(w, r, "lat and lng are required numbers")
		return
	}
	if err := validateCoordinates(lat, lng); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	// 5km default is the plan's starting search radius; the engine widens it
	// when nobody is found.
	radius := 5.0
	if raw := q.Get("radiusKm"); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed <= 0 || parsed > 200 {
			httpx.BadRequest(w, r, "radiusKm must be a number between 0 and 200")
			return
		}
		radius = parsed
	}

	limit := 50
	if raw := q.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > 500 {
			httpx.BadRequest(w, r, "limit must be between 1 and 500")
			return
		}
		limit = parsed
	}

	category := q.Get("category")
	if category != "" && !domain.IsValidCategory(category) {
		httpx.BadRequest(w, r, "unknown food category: "+category)
		return
	}

	agents, err := h.Store.Nearby(ctx, store.NearbyOptions{
		Lat:                lat,
		Lng:                lng,
		RadiusKm:           radius,
		Limit:              limit,
		Category:           category,
		IncludeUnavailable: q.Get("includeUnavailable") == "true",
	})
	if err != nil {
		logging.FromContext(ctx, h.Logger).Error("nearby query failed", "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"query": map[string]any{
			"lat": lat, "lng": lng, "radiusKm": radius, "category": category,
		},
		"count":  len(agents),
		"agents": agents,
	})
}

// ------------------------------------------------------------------ load

// AdjustLoad changes an agent's pending-pickup counter.
//
// In Phase 7 tracking-service drives this from Kafka events rather than HTTP -
// load changes are consequences of donation.accepted / .collected / .rejected,
// not something a client should assert. The endpoint exists now so the counter
// that feeds scoring can be exercised and demonstrated before those events are
// built.
func (h *Handlers) AdjustLoad(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agentID := r.PathValue("agentId")
	if agentID == "" {
		httpx.BadRequest(w, r, "agentId is required")
		return
	}

	var body struct {
		Delta int `json:"delta"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, r, "body must be JSON with a `delta` of +1 or -1")
		return
	}

	var (
		value int64
		err   error
	)
	switch {
	case body.Delta > 0:
		value, err = h.Store.IncrementLoad(ctx, agentID)
	case body.Delta < 0:
		value, err = h.Store.DecrementLoad(ctx, agentID)
	default:
		httpx.BadRequest(w, r, "delta must be non-zero")
		return
	}

	if err != nil {
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"agentId":     agentID,
		"currentLoad": value,
	})
}

// ----------------------------------------------------------------- helper

type validationError struct{ msg string }

func (e validationError) Error() string { return e.msg }

func validateCoordinates(lat, lng float64) error {
	// NaN and Inf would be stored by Redis without complaint and then poison
	// every distance calculation that touched them.
	if math.IsNaN(lat) || math.IsNaN(lng) || math.IsInf(lat, 0) || math.IsInf(lng, 0) {
		return validationError{"lat and lng must be finite numbers"}
	}
	if lat < -90 || lat > 90 {
		return validationError{"lat must be between -90 and 90"}
	}
	if lng < -180 || lng > 180 {
		return validationError{"lng must be between -180 and 180"}
	}
	return nil
}

// Package candidates answers "who could collect this donation?" by reading the
// Redis structures that agent-location-service writes.
//
// A NOTE ON THE COUPLING. Everywhere else in this system, one service never
// reads another's data store - donation-service does not query auth-service's
// MongoDB. Here it does, deliberately, and docs/PLAN.md specifies it: the
// engine finds agents "via Redis GEOSEARCH around the donation's location".
//
// The reasoning: this runs on the hot path of every single donation. Going
// through agent-location-service's HTTP layer would add a network hop, JSON
// encode/decode, and that service's availability to a query that Redis already
// answers in under a millisecond. Redis is shared operational infrastructure
// here, not one service's private database.
//
// The cost is real and worth naming: the KEY LAYOUT is now a contract between
// two services. If agent-location-service renames agent:<id>:caps, this breaks
// silently. That is why the layout is documented in both places and asserted by
// the smoke tests of both services.
package candidates

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"hungerheal/assignment-engine/internal/domain"
)

// These must match agent-location-service/internal/store/redis.go exactly.
const (
	geoKey   = "agents:live"
	capsFmt  = "agent:%s:caps"
	loadFmt  = "agent:%s:load"
	aliveFmt = "agent:%s:alive"
)

type Finder struct {
	rdb *redis.Client
}

func NewFinder(redisURL string) (*Finder, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("invalid REDIS_URL: %w", err)
	}
	return &Finder{rdb: redis.NewClient(opts)}, nil
}

func (f *Finder) Ping(ctx context.Context) error { return f.rdb.Ping(ctx).Err() }
func (f *Finder) Close() error                   { return f.rdb.Close() }

// Client exposes the underlying connection so the offer store can share it.
// One connection pool for both, rather than two pools to the same server.
func (f *Finder) Client() *redis.Client { return f.rdb }

// FindWithin returns every live agent within radiusKm of the point.
//
// It applies only the filters that are cheap and unambiguous here - online,
// has capabilities on record. Category eligibility and availability are left to
// the scoring package, so that ALL the matching rules live in one pure,
// unit-testable place rather than being split between a Redis query and a
// scoring function.
func (f *Finder) FindWithin(ctx context.Context, lat, lng, radiusKm float64, limit int) ([]domain.Candidate, error) {
	if limit <= 0 {
		limit = 100
	}

	results, err := f.rdb.GeoSearchLocation(ctx, geoKey, &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude:  lng, // longitude first - the same trap as GEOADD
			Latitude:   lat,
			Radius:     radiusKm,
			RadiusUnit: "km",
			Sort:       "ASC", // nearest first, so a Count cap keeps the closest
			Count:      limit,
		},
		WithCoord: true,
		WithDist:  true,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("geosearch failed: %w", err)
	}
	if len(results) == 0 {
		return []domain.Candidate{}, nil
	}

	// One pipeline for all three per-agent reads. With 100 candidates this is
	// 3 round trips instead of 300, on the path where latency is most costly.
	pipe := f.rdb.Pipeline()
	type pending struct {
		alive *redis.IntCmd
		caps  *redis.MapStringStringCmd
		load  *redis.StringCmd
	}
	cmds := make([]pending, len(results))
	for i, r := range results {
		cmds[i] = pending{
			alive: pipe.Exists(ctx, fmt.Sprintf(aliveFmt, r.Name)),
			caps:  pipe.HGetAll(ctx, fmt.Sprintf(capsFmt, r.Name)),
			load:  pipe.Get(ctx, fmt.Sprintf(loadFmt, r.Name)),
		}
	}
	// redis.Nil is expected: an agent with no accepted pickups has no load key.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("candidate enrichment failed: %w", err)
	}

	out := make([]domain.Candidate, 0, len(results))
	for i, r := range results {
		// A geo-set member cannot expire on its own, so the set can still hold
		// an agent whose heartbeat lapsed. Offering a donation to someone who
		// closed the app burns a whole timeout window for nothing.
		if alive, _ := cmds[i].alive.Result(); alive == 0 {
			continue
		}

		caps, err := cmds[i].caps.Result()
		if err != nil || len(caps) == 0 {
			// Position but no profile: nothing about them can be scored.
			continue
		}

		c := candidateFromHash(r.Name, caps)
		c.Lat = r.Latitude
		c.Lng = r.Longitude
		c.DistanceKm = r.Dist

		if load, err := cmds[i].load.Int(); err == nil {
			c.CurrentLoad = load
		}

		out = append(out, c)
	}

	return out, nil
}

func candidateFromHash(agentID string, h map[string]string) domain.Candidate {
	rating, _ := strconv.ParseFloat(h["rating"], 64)

	var categories []string
	if raw := h["categories"]; raw != "" {
		categories = strings.Split(raw, ",")
	}

	return domain.Candidate{
		AgentID: agentID,
		Name:    h["name"],
		Phone:   h["phone"],
		Rating:  rating,
		// Absent means available. An agent who never touched the toggle is
		// working, so the default must not quietly exclude them.
		Available: h["available"] != "0",
		Capabilities: domain.Capabilities{
			VehicleType:           h["vehicleType"],
			HasInsulatedTransport: h["insulated"] == "1",
			HasRefrigeration:      h["refrigerated"] == "1",
			CategoriesHandled:     categories,
		},
	}
}

// Stats is used by the health endpoint to show the engine can see agents.
func (f *Finder) Stats(ctx context.Context) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return f.rdb.ZCard(ctx, geoKey).Result()
}

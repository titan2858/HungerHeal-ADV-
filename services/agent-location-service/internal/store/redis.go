package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"hungerheal/agent-location-service/internal/domain"
)

// ---------------------------------------------------------------------------
// Three Redis structures hold one agent, and each is chosen for what it does
// well. Together they are what assignment-engine reads on every donation.
//
//  1. agents:live            GEO set   - "who is within 5km of this point?"
//  2. agent:<id>:caps        HASH      - what they can carry, rating, contact
//  3. agent:<id>:load        counter   - pending pickups, INCR/DECR atomically
//
// Plus a fourth that exists only to solve a constraint:
//
//  4. agent:<id>:alive       string with TTL - presence heartbeat
//
// WHY THE HEARTBEAT KEY EXISTS. A Redis geo set is a sorted set underneath, and
// while a whole KEY can expire, individual MEMBERS of a sorted set cannot. So
// there is no way to say "forget this agent's location in 2 minutes". Left
// alone, an agent who closes the app stays in the geo set forever at their last
// known position, and assignment-engine happily offers them donations they will
// never see - the donation then times out and has to be reassigned, wasting the
// exact minutes that matter most for hot food.
//
// The fix is two-part: a per-agent key that DOES expire, checked on every read,
// and a background reaper that removes geo entries whose heartbeat is gone so
// the set does not grow without bound.
// ---------------------------------------------------------------------------

const (
	GeoKey    = "agents:live"
	capsFmt   = "agent:%s:caps"
	loadFmt   = "agent:%s:load"
	aliveFmt  = "agent:%s:alive"
	trueValue = "1"

	// The field that marks a caps hash as a COMPLETE mirror of auth-service,
	// rather than a stub some other write happened to create.
	//
	// This matters because HSET creates the hash if it is missing, so any
	// single-field write - SetAvailability, for one - brings the key into
	// existence. Testing EXISTS would then report "capabilities are on record"
	// for a hash holding nothing but `available`, and the agent would be
	// filtered out of every donation for having no categories. Only
	// SaveCapabilities writes this field, so only SaveCapabilities can satisfy
	// the check.
	capsCompleteField = "updatedAt"
)

func CapsKey(agentID string) string  { return fmt.Sprintf(capsFmt, agentID) }
func LoadKey(agentID string) string  { return fmt.Sprintf(loadFmt, agentID) }
func AliveKey(agentID string) string { return fmt.Sprintf(aliveFmt, agentID) }

type Store struct {
	rdb      *redis.Client
	agentTTL time.Duration
}

func New(redisURL string, agentTTL time.Duration) (*Store, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("invalid REDIS_URL: %w", err)
	}
	return &Store{rdb: redis.NewClient(opts), agentTTL: agentTTL}, nil
}

func (s *Store) Ping(ctx context.Context) error { return s.rdb.Ping(ctx).Err() }
func (s *Store) Close() error                   { return s.rdb.Close() }
func (s *Store) Client() *redis.Client          { return s.rdb }

// TTL is how long a location stays trusted without a fresh heartbeat. Returned
// to clients so they can pick a reporting interval instead of guessing.
func (s *Store) TTL() time.Duration { return s.agentTTL }

// UpsertLocation records where an agent is right now and refreshes their
// heartbeat.
//
// Both writes go in one pipeline: fewer round trips, and the two facts
// ("here is my position" / "I am still online") stay together rather than
// drifting apart if the second call failed.
func (s *Store) UpsertLocation(ctx context.Context, agentID string, lat, lng float64) error {
	pipe := s.rdb.TxPipeline()

	// GEOADD stores the point. Note the argument order: LONGITUDE first.
	// Reversing them is silent - no error, just an agent who appears to be in
	// the wrong hemisphere and is never matched to anything nearby.
	pipe.GeoAdd(ctx, GeoKey, &redis.GeoLocation{
		Name:      agentID,
		Longitude: lng,
		Latitude:  lat,
	})

	// The heartbeat. Refreshed on every location report, so it survives exactly
	// as long as the agent keeps reporting.
	pipe.Set(ctx, AliveKey(agentID), trueValue, s.agentTTL)

	_, err := pipe.Exec(ctx)
	return err
}

// SaveCapabilities mirrors an agent's registration data from auth-service into
// Redis, where the matching hot path can read it without touching MongoDB.
func (s *Store) SaveCapabilities(ctx context.Context, agentID string, a domain.Agent) error {
	fields := map[string]any{
		"name":         a.Name,
		"phone":        a.Phone,
		"vehicleType":  a.Capabilities.VehicleType,
		"insulated":    boolToStr(a.Capabilities.HasInsulatedTransport),
		"refrigerated": boolToStr(a.Capabilities.HasRefrigeration),
		// Stored as a delimited string rather than a nested structure: Redis
		// hash values are flat strings, and the list is short and read whole.
		"categories":      strings.Join(a.Capabilities.CategoriesHandled, ","),
		"rating":          strconv.FormatFloat(a.Rating, 'f', 2, 64),
		capsCompleteField: time.Now().UTC().Format(time.RFC3339),
	}

	// `available` is live shift state, not registration data, so it is only
	// seeded when nothing has set it yet. Writing it unconditionally would let
	// a mirror silently flip an agent back to "accepting work" after they had
	// just turned it off - auth-service defaults it to true and has no idea
	// what the agent chose thirty seconds ago.
	existing, err := s.rdb.HGet(ctx, CapsKey(agentID), "available").Result()
	if err != nil && err != redis.Nil {
		return err
	}
	if err == redis.Nil || existing == "" {
		fields["available"] = boolToStr(a.Available)
	}

	// No TTL: capabilities are not presence. An agent who goes offline for a
	// week has not stopped owning an insulated box, and re-fetching this from
	// auth-service on every reconnect would be wasted work.
	return s.rdb.HSet(ctx, CapsKey(agentID), fields).Err()
}

// HasCapabilities reports whether a COMPLETE capability mirror is on record.
//
// Deliberately not EXISTS on the key: see capsCompleteField. A hash created by
// some other single-field write is not a mirror, and treating it as one leaves
// the agent with no categories and therefore ineligible for every donation.
func (s *Store) HasCapabilities(ctx context.Context, agentID string) (bool, error) {
	return s.rdb.HExists(ctx, CapsKey(agentID), capsCompleteField).Result()
}

// SavePartialProfile records what is known about an agent when auth-service
// could not be reached - name and phone from their token, and nothing about
// what they can carry.
//
// It deliberately omits capsCompleteField, so HasCapabilities keeps returning
// false and the next request retries the mirror. Writing the sentinel here
// would make a record with no categories look finished, and the agent would be
// hard-filtered out of every donation for as long as the key survived - which
// is precisely the bug this field exists to prevent.
func (s *Store) SavePartialProfile(ctx context.Context, agentID string, a domain.Agent) error {
	return s.rdb.HSet(ctx, CapsKey(agentID), map[string]any{
		"name":   a.Name,
		"phone":  a.Phone,
		"rating": strconv.FormatFloat(a.Rating, 'f', 2, 64),
	}).Err()
}

// SetAvailability flips whether the agent is accepting work, without discarding
// their capabilities or position.
func (s *Store) SetAvailability(ctx context.Context, agentID string, available bool) error {
	return s.rdb.HSet(ctx, CapsKey(agentID), "available", boolToStr(available)).Err()
}

// GoOffline removes the agent from consideration immediately, rather than
// waiting for the heartbeat to lapse. Used when an agent explicitly signs off,
// so they stop receiving offers at once instead of up to AgentTTL later.
func (s *Store) GoOffline(ctx context.Context, agentID string) error {
	pipe := s.rdb.TxPipeline()
	pipe.ZRem(ctx, GeoKey, agentID)
	pipe.Del(ctx, AliveKey(agentID))
	_, err := pipe.Exec(ctx)
	return err
}

// CurrentLoad reads the agent's pending-pickup counter.
func (s *Store) CurrentLoad(ctx context.Context, agentID string) (int, error) {
	v, err := s.rdb.Get(ctx, LoadKey(agentID)).Int()
	if err == redis.Nil {
		// No key yet simply means no accepted pickups.
		return 0, nil
	}
	return v, err
}

// IncrementLoad is called when an agent accepts a donation, DecrementLoad when
// they collect or reject one (Phase 7 drives both from Kafka events).
//
// INCR/DECR are atomic, so two services adjusting the same counter concurrently
// cannot lose an update - which a read-modify-write would.
func (s *Store) IncrementLoad(ctx context.Context, agentID string) (int64, error) {
	return s.rdb.Incr(ctx, LoadKey(agentID)).Result()
}

func (s *Store) DecrementLoad(ctx context.Context, agentID string) (int64, error) {
	n, err := s.rdb.Decr(ctx, LoadKey(agentID)).Result()
	if err != nil {
		return n, err
	}
	// A duplicate decrement (Kafka delivers at least once) could otherwise push
	// the counter negative, which would make the agent look MORE available the
	// more events were replayed - exactly backwards.
	if n < 0 {
		if err := s.rdb.Set(ctx, LoadKey(agentID), 0, 0).Err(); err != nil {
			return n, err
		}
		return 0, nil
	}
	return n, nil
}

// GetAgent assembles one agent from all three structures.
func (s *Store) GetAgent(ctx context.Context, agentID string) (*domain.Agent, error) {
	caps, err := s.rdb.HGetAll(ctx, CapsKey(agentID)).Result()
	if err != nil {
		return nil, err
	}
	if len(caps) == 0 {
		return nil, nil
	}

	agent := agentFromHash(agentID, caps)

	// Position comes from the geo set. An agent may have capabilities on record
	// without a current position - registered, but not currently sharing
	// location - so a missing position is not an error.
	if positions, err := s.rdb.GeoPos(ctx, GeoKey, agentID).Result(); err == nil {
		if len(positions) > 0 && positions[0] != nil {
			agent.Lat = positions[0].Latitude
			agent.Lng = positions[0].Longitude
		}
	}

	if load, err := s.CurrentLoad(ctx, agentID); err == nil {
		agent.CurrentLoad = load
	}

	return &agent, nil
}

// IsOnline reports whether the agent's heartbeat is still alive.
func (s *Store) IsOnline(ctx context.Context, agentID string) (bool, error) {
	n, err := s.rdb.Exists(ctx, AliveKey(agentID)).Result()
	return n > 0, err
}

// NearbyOptions filters a radius search.
type NearbyOptions struct {
	Lat      float64
	Lng      float64
	RadiusKm float64
	// Limit caps how many candidates come back. assignment-engine only needs
	// the best few, and scoring every agent in a city would be wasted work.
	Limit int
	// Category, when set, drops agents who do not handle it. A hard filter, not
	// a score penalty: offering cooked food to someone who only carries
	// packaged goods is never right, however close they are.
	Category string
	// IncludeUnavailable includes agents who have marked themselves as not
	// accepting work. Useful for a monitoring view, never for matching.
	IncludeUnavailable bool
}

// Nearby answers the question assignment-engine asks on every single donation:
// "who is within X km of this pickup, and what do I need to know to rank them?"
//
// This is why Redis is in the stack. The alternative - loading every agent from
// MongoDB and computing distance to each in application code - gets linearly
// slower as agents are added, and runs on the one path where latency directly
// costs food quality.
func (s *Store) Nearby(ctx context.Context, opts NearbyOptions) ([]domain.NearbyAgent, error) {
	if opts.Limit <= 0 {
		opts.Limit = 50
	}

	// GEOSEARCH replaces the deprecated GEORADIUS. Sorted ascending, so the
	// nearest candidates arrive first and a Count cap keeps the closest ones.
	results, err := s.rdb.GeoSearchLocation(ctx, GeoKey, &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude:  opts.Lng,
			Latitude:   opts.Lat,
			Radius:     opts.RadiusKm,
			RadiusUnit: "km",
			Sort:       "ASC",
			Count:      opts.Limit,
		},
		WithCoord: true,
		WithDist:  true,
	}).Result()
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return []domain.NearbyAgent{}, nil
	}

	// One pipeline for every candidate's heartbeat, capabilities and load,
	// instead of three round trips per agent. With 50 candidates that is the
	// difference between 3 round trips and 150.
	pipe := s.rdb.Pipeline()
	type pending struct {
		alive *redis.IntCmd
		caps  *redis.MapStringStringCmd
		load  *redis.StringCmd
	}
	cmds := make([]pending, len(results))
	for i, r := range results {
		cmds[i] = pending{
			alive: pipe.Exists(ctx, AliveKey(r.Name)),
			caps:  pipe.HGetAll(ctx, CapsKey(r.Name)),
			load:  pipe.Get(ctx, LoadKey(r.Name)),
		}
	}
	// redis.Nil is expected here: an agent with no accepted pickups has no load
	// key at all. Only a genuine transport error should abort.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}

	agents := make([]domain.NearbyAgent, 0, len(results))
	for i, r := range results {
		// STALENESS FILTER. The geo set may still hold an agent whose heartbeat
		// expired - the reaper runs periodically, not instantly - so presence is
		// checked here on every read rather than trusted from the set alone.
		if alive, _ := cmds[i].alive.Result(); alive == 0 {
			continue
		}

		capsMap, err := cmds[i].caps.Result()
		if err != nil || len(capsMap) == 0 {
			// Position but no capabilities: nothing can be scored about them.
			continue
		}

		agent := agentFromHash(r.Name, capsMap)

		if !opts.IncludeUnavailable && !agent.Available {
			continue
		}
		if opts.Category != "" && !agent.Capabilities.Handles(opts.Category) {
			continue
		}

		if load, err := cmds[i].load.Int(); err == nil {
			agent.CurrentLoad = load
		}

		agent.Lat = r.Latitude
		agent.Lng = r.Longitude

		agents = append(agents, domain.NearbyAgent{
			Agent:      agent,
			DistanceKm: round(r.Dist, 3),
		})
	}

	return agents, nil
}

// Reap removes geo-set entries whose heartbeat has expired.
//
// The read path already skips stale agents, so this is not about correctness -
// it is about the geo set not accumulating every agent who ever used the app.
// An unbounded sorted set makes GEOSEARCH scan more and costs memory forever.
func (s *Store) Reap(ctx context.Context) (int, error) {
	members, err := s.rdb.ZRange(ctx, GeoKey, 0, -1).Result()
	if err != nil || len(members) == 0 {
		return 0, err
	}

	pipe := s.rdb.Pipeline()
	checks := make([]*redis.IntCmd, len(members))
	for i, m := range members {
		checks[i] = pipe.Exists(ctx, AliveKey(m))
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return 0, err
	}

	stale := make([]any, 0)
	for i, m := range members {
		if alive, _ := checks[i].Result(); alive == 0 {
			stale = append(stale, m)
		}
	}
	if len(stale) == 0 {
		return 0, nil
	}

	if err := s.rdb.ZRem(ctx, GeoKey, stale...).Err(); err != nil {
		return 0, err
	}
	return len(stale), nil
}

// CountOnline is a cheap figure for the health endpoint and monitoring.
func (s *Store) CountOnline(ctx context.Context) (int64, error) {
	return s.rdb.ZCard(ctx, GeoKey).Result()
}

// ---------------------------------------------------------------- helpers

func agentFromHash(agentID string, h map[string]string) domain.Agent {
	rating, _ := strconv.ParseFloat(h["rating"], 64)

	var categories []string
	if raw := h["categories"]; raw != "" {
		categories = strings.Split(raw, ",")
	}

	lastSeen, _ := time.Parse(time.RFC3339, h["updatedAt"])

	return domain.Agent{
		AgentID: agentID,
		Name:    h["name"],
		Phone:   h["phone"],
		Rating:  rating,
		// Absent means available: an agent who never touched the toggle is
		// working, so the default must not exclude them from every match.
		Available: h["available"] != "0",
		LastSeen:  lastSeen,
		Capabilities: domain.Capabilities{
			VehicleType:           h["vehicleType"],
			HasInsulatedTransport: h["insulated"] == trueValue,
			HasRefrigeration:      h["refrigerated"] == trueValue,
			CategoriesHandled:     categories,
		},
	}
}

func boolToStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func round(v float64, places int) float64 {
	shift := float64(1)
	for i := 0; i < places; i++ {
		shift *= 10
	}
	return float64(int64(v*shift+0.5)) / shift
}

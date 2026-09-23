package store

import (
	"context"
	"os"
	"testing"
	"time"

	"hungerheal/agent-location-service/internal/domain"
)

// These run against the real dockerized Redis rather than a fake. The whole
// point of this package is GEOADD/GEOSEARCH semantics and per-member expiry -
// a mock would only assert that we call the functions we wrote, not that Redis
// behaves the way the design assumes.

const (
	// Real Bengaluru landmarks, so the distances between them are genuine.
	mgRoadLat, mgRoadLng           = 12.9757, 77.6068
	churchStLat, churchStLng       = 12.9756, 77.6033 // ~380m from MG Road
	koramangalaLat, koramangalaLng = 12.9352, 77.6245 // ~5km from MG Road
	mumbaiLat, mumbaiLng           = 19.0760, 72.8777 // ~850km away
)

func testStore(t *testing.T) *Store {
	t.Helper()

	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		url = "redis://localhost:6379"
	}

	// A short TTL so expiry is observable inside a test run.
	st, err := New(url, 2*time.Second)
	if err != nil {
		t.Fatalf("could not create store: %v", err)
	}

	ctx := context.Background()
	if err := st.Ping(ctx); err != nil {
		t.Skipf("redis not reachable at %s (run `docker compose up -d redis`): %v", url, err)
	}

	cleanup(t, st)
	t.Cleanup(func() {
		cleanup(t, st)
		st.Close()
	})

	return st
}

// Removes only this suite's keys. FLUSHALL would destroy the geocoding cache
// and anything else sharing the instance.
func cleanup(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()

	st.Client().Del(ctx, GeoKey)
	if keys, err := st.Client().Keys(ctx, "agent:test-*").Result(); err == nil && len(keys) > 0 {
		st.Client().Del(ctx, keys...)
	}
}

func sampleAgent(id string, categories ...string) domain.Agent {
	if len(categories) == 0 {
		categories = []string{"COOKED_PREPARED", "BAKERY"}
	}
	return domain.Agent{
		AgentID:   id,
		Name:      "Test Agent " + id,
		Phone:     "+91 9000000000",
		Rating:    4.2,
		Available: true,
		Capabilities: domain.Capabilities{
			VehicleType:           "MOTORCYCLE",
			HasInsulatedTransport: true,
			HasRefrigeration:      false,
			CategoriesHandled:     categories,
		},
	}
}

// register puts an agent fully on the map: capabilities plus a position.
func register(t *testing.T, st *Store, id string, lat, lng float64, categories ...string) {
	t.Helper()
	ctx := context.Background()

	if err := st.SaveCapabilities(ctx, id, sampleAgent(id, categories...)); err != nil {
		t.Fatalf("SaveCapabilities: %v", err)
	}
	if err := st.UpsertLocation(ctx, id, lat, lng); err != nil {
		t.Fatalf("UpsertLocation: %v", err)
	}
}

func TestUpsertLocationStoresPositionAndHeartbeat(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-a", mgRoadLat, mgRoadLng)

	online, err := st.IsOnline(ctx, "test-a")
	if err != nil || !online {
		t.Fatalf("agent should be online right after reporting: online=%v err=%v", online, err)
	}

	agent, err := st.GetAgent(ctx, "test-a")
	if err != nil || agent == nil {
		t.Fatalf("GetAgent: %v", err)
	}

	// Redis geo storage is lossy (geohash encoding), so coordinates come back
	// very slightly different. Anything within ~1m is the same doorway.
	if diff := agent.Lat - mgRoadLat; diff > 0.0001 || diff < -0.0001 {
		t.Errorf("latitude round-tripped as %v, want ~%v", agent.Lat, mgRoadLat)
	}
	if diff := agent.Lng - mgRoadLng; diff > 0.0001 || diff < -0.0001 {
		t.Errorf("longitude round-tripped as %v, want ~%v", agent.Lng, mgRoadLng)
	}
}

func TestNearbyFindsCloseAgentsAndExcludesDistantOnes(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-close", churchStLat, churchStLng) // ~380m
	register(t, st, "test-mid", koramangalaLat, koramangalaLng)
	register(t, st, "test-far", mumbaiLat, mumbaiLng) // ~850km

	agents, err := st.Nearby(ctx, NearbyOptions{
		Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2,
	})
	if err != nil {
		t.Fatalf("Nearby: %v", err)
	}

	if len(agents) != 1 {
		t.Fatalf("expected exactly 1 agent within 2km, got %d", len(agents))
	}
	if agents[0].AgentID != "test-close" {
		t.Errorf("wrong agent returned: %s", agents[0].AgentID)
	}
	// The whole reason Redis is here: distance computed by the datastore.
	if agents[0].DistanceKm <= 0 || agents[0].DistanceKm > 1 {
		t.Errorf("distance %v km is not plausible for ~380m", agents[0].DistanceKm)
	}
}

func TestNearbyReturnsNearestFirst(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-mid", koramangalaLat, koramangalaLng)
	register(t, st, "test-close", churchStLat, churchStLng)

	agents, err := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 10})
	if err != nil {
		t.Fatalf("Nearby: %v", err)
	}
	if len(agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(agents))
	}

	// Sorted ascending, so a Count cap keeps the CLOSEST candidates rather than
	// an arbitrary subset.
	if agents[0].AgentID != "test-close" {
		t.Errorf("expected nearest agent first, got %s", agents[0].AgentID)
	}
	if agents[0].DistanceKm > agents[1].DistanceKm {
		t.Errorf("results not sorted by distance: %v then %v",
			agents[0].DistanceKm, agents[1].DistanceKm)
	}
}

func TestNearbyExcludesAgentsWhoseHeartbeatExpired(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-ghost", churchStLat, churchStLng)

	found, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(found) != 1 {
		t.Fatalf("agent should be found while their heartbeat is alive, got %d", len(found))
	}

	// The TTL in tests is 2s. A geo-set member cannot expire on its own, so
	// after this wait the position is STILL in the set - and the read path must
	// exclude it anyway, or an agent who closed the app keeps getting offers.
	time.Sleep(2500 * time.Millisecond)

	stillInGeoSet, _ := st.Client().ZScore(ctx, GeoKey, "test-ghost").Result()
	if stillInGeoSet == 0 {
		t.Log("note: geo entry already gone; the read-path filter is what this test asserts")
	}

	found, err := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if err != nil {
		t.Fatalf("Nearby: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("a stale agent must not be offered donations, got %d agents", len(found))
	}
}

func TestReaperRemovesStaleGeoEntries(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-stale", churchStLat, churchStLng)
	register(t, st, "test-fresh", mgRoadLat, mgRoadLng)

	// Expire one heartbeat without touching the other.
	st.Client().Del(ctx, AliveKey("test-stale"))

	removed, err := st.Reap(ctx)
	if err != nil {
		t.Fatalf("Reap: %v", err)
	}
	if removed != 1 {
		t.Errorf("expected 1 stale entry reaped, got %d", removed)
	}

	// Without the reaper the geo set would accumulate every agent who ever used
	// the app, making every search scan more and holding memory forever.
	if n, _ := st.Client().ZCard(ctx, GeoKey).Result(); n != 1 {
		t.Errorf("expected 1 agent left in the geo set, got %d", n)
	}
	if score, err := st.Client().ZScore(ctx, GeoKey, "test-fresh").Result(); err != nil || score == 0 {
		t.Errorf("the live agent must survive the reap")
	}
}

func TestNearbyFiltersByCategory(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-cooked", churchStLat, churchStLng, "COOKED_PREPARED")
	register(t, st, "test-packaged", churchStLat, churchStLng, "PACKAGED_NON_PERISHABLE")

	agents, err := st.Nearby(ctx, NearbyOptions{
		Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2, Category: "COOKED_PREPARED",
	})
	if err != nil {
		t.Fatalf("Nearby: %v", err)
	}

	// A hard filter, not a score penalty: offering cooked food to an agent who
	// only carries packaged goods is never right, however close they are.
	if len(agents) != 1 || agents[0].AgentID != "test-cooked" {
		t.Errorf("category filter failed, got %+v", agents)
	}
}

func TestNearbyExcludesUnavailableAgents(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-busy", churchStLat, churchStLng)
	if err := st.SetAvailability(ctx, "test-busy", false); err != nil {
		t.Fatalf("SetAvailability: %v", err)
	}

	agents, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(agents) != 0 {
		t.Errorf("an unavailable agent must not be matched, got %d", len(agents))
	}

	// Still visible to a monitoring view that asks for them.
	agents, _ = st.Nearby(ctx, NearbyOptions{
		Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2, IncludeUnavailable: true,
	})
	if len(agents) != 1 {
		t.Errorf("includeUnavailable should return the agent, got %d", len(agents))
	}
}

func TestNearbySkipsAgentsWithNoCapabilities(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	// A position but no capability hash: nothing about them can be scored, so
	// they must not be returned as a candidate.
	if err := st.UpsertLocation(ctx, "test-orphan", churchStLat, churchStLng); err != nil {
		t.Fatalf("UpsertLocation: %v", err)
	}

	agents, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(agents) != 0 {
		t.Errorf("an agent with no capabilities must be skipped, got %d", len(agents))
	}
}

func TestNearbyRespectsLimit(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	for _, id := range []string{"test-1", "test-2", "test-3"} {
		register(t, st, id, churchStLat, churchStLng)
	}

	agents, _ := st.Nearby(ctx, NearbyOptions{
		Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 5, Limit: 2,
	})
	if len(agents) != 2 {
		t.Errorf("expected the limit to cap results at 2, got %d", len(agents))
	}
}

func TestLoadCounter(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-load", mgRoadLat, mgRoadLng)

	if load, _ := st.CurrentLoad(ctx, "test-load"); load != 0 {
		t.Errorf("a new agent should start at zero load, got %d", load)
	}

	st.IncrementLoad(ctx, "test-load")
	st.IncrementLoad(ctx, "test-load")
	if load, _ := st.CurrentLoad(ctx, "test-load"); load != 2 {
		t.Errorf("expected load 2, got %d", load)
	}

	st.DecrementLoad(ctx, "test-load")
	if load, _ := st.CurrentLoad(ctx, "test-load"); load != 1 {
		t.Errorf("expected load 1 after collection, got %d", load)
	}
}

func TestLoadCounterNeverGoesNegative(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-neg", mgRoadLat, mgRoadLng)

	// Kafka delivers at least once, so a replayed donation.collected event can
	// decrement twice. Going negative would make the agent look MORE available
	// the more events were replayed - exactly backwards.
	st.IncrementLoad(ctx, "test-neg")
	st.DecrementLoad(ctx, "test-neg")
	st.DecrementLoad(ctx, "test-neg")
	st.DecrementLoad(ctx, "test-neg")

	if load, _ := st.CurrentLoad(ctx, "test-neg"); load != 0 {
		t.Errorf("load must clamp at 0, got %d", load)
	}
}

func TestNearbyIncludesLoadForScoring(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-loaded", churchStLat, churchStLng)
	st.IncrementLoad(ctx, "test-loaded")
	st.IncrementLoad(ctx, "test-loaded")

	agents, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(agents))
	}

	// Everything the scoring formula needs must come back in ONE query -
	// otherwise assignment-engine makes a round trip per candidate.
	if agents[0].CurrentLoad != 2 {
		t.Errorf("expected load 2 in the nearby result, got %d", agents[0].CurrentLoad)
	}
	if agents[0].Rating != 4.2 {
		t.Errorf("expected rating 4.2, got %v", agents[0].Rating)
	}
	if !agents[0].Capabilities.HasInsulatedTransport {
		t.Error("expected insulated transport capability to survive the round trip")
	}
	if len(agents[0].Capabilities.CategoriesHandled) == 0 {
		t.Error("expected categories in the nearby result")
	}
}

func TestGoOfflineRemovesAgentImmediately(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-signoff", churchStLat, churchStLng)

	if err := st.GoOffline(ctx, "test-signoff"); err != nil {
		t.Fatalf("GoOffline: %v", err)
	}

	// Immediately, not after the heartbeat lapses - an agent ending their shift
	// should stop receiving offers at once.
	agents, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(agents) != 0 {
		t.Errorf("a signed-off agent must not be matched, got %d", len(agents))
	}

	// But their capabilities survive, so coming back online costs no auth-service call.
	has, _ := st.HasCapabilities(ctx, "test-signoff")
	if !has {
		t.Error("capabilities should outlive a sign-off")
	}
}

func TestMovingAgentUpdatesPositionRatherThanDuplicating(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	register(t, st, "test-moving", mumbaiLat, mumbaiLng)
	if err := st.UpsertLocation(ctx, "test-moving", churchStLat, churchStLng); err != nil {
		t.Fatalf("UpsertLocation: %v", err)
	}

	// GEOADD on an existing member updates it. One agent is one member, so a
	// moving agent cannot appear twice.
	if n, _ := st.Client().ZCard(ctx, GeoKey).Result(); n != 1 {
		t.Errorf("expected 1 geo member after a move, got %d", n)
	}

	agents, _ := st.Nearby(ctx, NearbyOptions{Lat: mgRoadLat, Lng: mgRoadLng, RadiusKm: 2})
	if len(agents) != 1 {
		t.Errorf("agent should be found at their NEW position, got %d", len(agents))
	}
}

// ---------------------------------------------------------------------------
// Regression: an agent who toggled availability before their first location
// report was silently excluded from every donation.
//
// SetAvailability's HSET creates the caps hash, so a HasCapabilities built on
// EXISTS reported "already mirrored" for a hash holding nothing but
// `available`. The mirror then never ran, the agent had no categories, and the
// engine's hard category filter dropped them at any distance. Found in the
// running system: an agent with all five categories on record in auth-service
// was refused donations 300m away.
// ---------------------------------------------------------------------------

func TestSetAvailabilityDoesNotFakeACapabilityRecord(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	const id = "test-order"

	if err := st.SetAvailability(ctx, id, true); err != nil {
		t.Fatalf("SetAvailability: %v", err)
	}

	// The key now exists, but nothing has mirrored capabilities into it. The
	// caller must still be told to fetch them.
	known, err := st.HasCapabilities(ctx, id)
	if err != nil {
		t.Fatalf("HasCapabilities: %v", err)
	}
	if known {
		t.Fatal("HasCapabilities reported a complete record after only SetAvailability; " +
			"the capability mirror would be skipped and the agent left with no categories")
	}

	if err := st.SaveCapabilities(ctx, id, sampleAgent(id)); err != nil {
		t.Fatalf("SaveCapabilities: %v", err)
	}
	known, err = st.HasCapabilities(ctx, id)
	if err != nil {
		t.Fatalf("HasCapabilities after save: %v", err)
	}
	if !known {
		t.Fatal("HasCapabilities did not recognise a genuinely complete record")
	}
}

func TestAgentIsMatchableWhenAvailabilityPrecedesFirstLocation(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	const id = "test-order-e2e"

	// The exact order the UI produces: the shift panel offers the availability
	// toggle while the browser is still acquiring a GPS fix.
	if err := st.SetAvailability(ctx, id, true); err != nil {
		t.Fatalf("SetAvailability: %v", err)
	}

	if known, _ := st.HasCapabilities(ctx, id); !known {
		if err := st.SaveCapabilities(ctx, id, sampleAgent(id, "COOKED_PREPARED")); err != nil {
			t.Fatalf("SaveCapabilities: %v", err)
		}
	}
	if err := st.UpsertLocation(ctx, id, mgRoadLat, mgRoadLng); err != nil {
		t.Fatalf("UpsertLocation: %v", err)
	}

	found, err := st.Nearby(ctx, NearbyOptions{
		Lat: churchStLat, Lng: churchStLng, RadiusKm: 5, Limit: 10,
	})
	if err != nil {
		t.Fatalf("Nearby: %v", err)
	}

	var seen *domain.NearbyAgent
	for i := range found {
		if found[i].AgentID == id {
			seen = &found[i]
			break
		}
	}
	if seen == nil {
		t.Fatal("agent not returned by Nearby at 380m")
	}
	if !seen.Capabilities.Handles("COOKED_PREPARED") {
		t.Fatalf("agent came back with categories %v; the engine's hard category "+
			"filter would exclude them from every donation",
			seen.Capabilities.CategoriesHandled)
	}
}

func TestMirroringDoesNotResurrectAvailability(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	const id = "test-avail-keep"

	// The agent says "stop sending me work", and only then does the mirror run.
	if err := st.SetAvailability(ctx, id, false); err != nil {
		t.Fatalf("SetAvailability: %v", err)
	}

	// sampleAgent is Available: true, as auth-service's default would be.
	if err := st.SaveCapabilities(ctx, id, sampleAgent(id)); err != nil {
		t.Fatalf("SaveCapabilities: %v", err)
	}

	agent, err := st.GetAgent(ctx, id)
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if agent.Available {
		t.Fatal("mirroring flipped the agent back to available; " +
			"registration data must not overwrite live shift state")
	}
}

// A degraded write must not look like a finished one. When auth-service is
// unreachable the service stores name and phone from the token, which says
// nothing about what the agent can carry - so the mirror has to remain
// pending, or the agent is hard-filtered out of every donation until something
// deletes the key.
func TestPartialProfileStaysRetryable(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	const id = "test-partial"

	if err := st.SavePartialProfile(ctx, id, domain.Agent{
		AgentID: id, Name: "Token Only", Phone: "+91 9000000001", Rating: 3.5,
	}); err != nil {
		t.Fatalf("SavePartialProfile: %v", err)
	}

	known, err := st.HasCapabilities(ctx, id)
	if err != nil {
		t.Fatalf("HasCapabilities: %v", err)
	}
	if known {
		t.Fatal("a partial profile reported itself as a complete mirror; " +
			"the retry would never happen and the agent would carry no categories")
	}

	// Once auth-service recovers, the real mirror completes it.
	if err := st.SaveCapabilities(ctx, id, sampleAgent(id, "BAKERY")); err != nil {
		t.Fatalf("SaveCapabilities: %v", err)
	}
	if known, _ := st.HasCapabilities(ctx, id); !known {
		t.Fatal("the completed mirror was still not recognised")
	}

	agent, err := st.GetAgent(ctx, id)
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if !agent.Capabilities.Handles("BAKERY") {
		t.Fatalf("categories missing after recovery: %v", agent.Capabilities.CategoriesHandled)
	}
}

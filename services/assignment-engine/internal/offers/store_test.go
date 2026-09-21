package offers

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Against the real dockerized Redis, not a fake. The whole package rests on the
// exact semantics of SETNX, ZREM and sorted-set range queries under
// concurrency - a fake would only prove we call the functions we wrote.

func testStore(t *testing.T) (*Store, *redis.Client) {
	t.Helper()

	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		url = "redis://localhost:6379"
	}

	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("bad redis url: %v", err)
	}
	rdb := redis.NewClient(opts)

	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("redis not reachable at %s: %v", url, err)
	}

	store := New(rdb, time.Minute)
	cleanup(t, rdb)
	t.Cleanup(func() { cleanup(t, rdb); rdb.Close() })

	return store, rdb
}

// Deletes only this suite's keys. FLUSHALL would destroy the geocoding cache
// and every live agent location sharing the instance.
func cleanup(t *testing.T, rdb *redis.Client) {
	t.Helper()
	ctx := context.Background()

	for _, pattern := range []string{"donation:test-*", "processed:test-*", "agent:test-*"} {
		if keys, err := rdb.Keys(ctx, pattern).Result(); err == nil && len(keys) > 0 {
			rdb.Del(ctx, keys...)
		}
	}
	// Remove only this suite's members from the shared deadline set.
	if members, err := rdb.ZRange(ctx, DeadlinesKey, 0, -1).Result(); err == nil {
		for _, m := range members {
			if len(m) > 5 && m[:5] == "test-" {
				rdb.ZRem(ctx, DeadlinesKey, m)
			}
		}
	}
}

func sampleState(donationID string, offeredTo ...string) State {
	return State{
		DonationID: donationID,
		DonorID:    "test-donor",
		Category:   "COOKED_PREPARED",
		Address:    "12 MG Road, Bengaluru",
		Lat:        12.9757,
		Lng:        77.6068,
		TraceID:    "test-trace",
		Round:      1,
		RadiusKm:   5,
		OfferedTo:  offeredTo,
		ExpiresAt:  time.Now().UTC().Add(90 * time.Second),
	}
}

// ---------------------------------------------------------------- dedup

func TestBeginProcessingIsTrueOnceThenFalse(t *testing.T) {
	// The fix for Kafka's at-least-once delivery. The second delivery of the
	// same event must be skipped, or the donation is assigned twice and six
	// agents are notified for one meal.
	store, _ := testStore(t)
	ctx := context.Background()

	first, err := store.BeginProcessing(ctx, "test-evt-1")
	if err != nil || !first {
		t.Fatalf("the first delivery should be processed: %v %v", first, err)
	}

	second, err := store.BeginProcessing(ctx, "test-evt-1")
	if err != nil {
		t.Fatalf("BeginProcessing: %v", err)
	}
	if second {
		t.Error("a redelivered event must be skipped")
	}
}

func TestConcurrentDeliveriesOfOneEventProcessItOnce(t *testing.T) {
	// Two engine instances can receive the same redelivery simultaneously.
	// SETNX is what makes exactly one of them win.
	store, _ := testStore(t)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		granted int
	)

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := store.BeginProcessing(context.Background(), "test-evt-race"); err == nil && ok {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if granted != 1 {
		t.Errorf("exactly one caller should process the event, got %d", granted)
	}
}

func TestAbandonProcessingLetsAFailedEventBeRetried(t *testing.T) {
	// The marker is set BEFORE the work runs. If the work then fails and the
	// marker stayed, the redelivery would skip a donation that never actually
	// got processed - losing it exactly when the system is already struggling.
	store, _ := testStore(t)
	ctx := context.Background()

	store.BeginProcessing(ctx, "test-evt-fail")
	if err := store.AbandonProcessing(ctx, "test-evt-fail"); err != nil {
		t.Fatalf("AbandonProcessing: %v", err)
	}

	again, _ := store.BeginProcessing(ctx, "test-evt-fail")
	if !again {
		t.Error("after a failure the event must be processable again")
	}
}

func TestAnEventWithNoIdIsProcessedRatherThanSkipped(t *testing.T) {
	// Nothing to deduplicate on. Processing is the lesser evil - skipping would
	// silently drop a real donation.
	store, _ := testStore(t)

	ok, err := store.BeginProcessing(context.Background(), "")
	if err != nil || !ok {
		t.Errorf("an event with no id should still be processed: %v %v", ok, err)
	}
}

// ----------------------------------------------------------- claim lock

func TestClaimIsWonByExactlyOneAgent(t *testing.T) {
	store, _ := testStore(t)
	ctx := context.Background()

	if err := store.Claim(ctx, "test-don-1", "agent-a", time.Minute); err != nil {
		t.Fatalf("the first agent should win: %v", err)
	}
	if err := store.Claim(ctx, "test-don-1", "agent-b", time.Minute); err != ErrAlreadyClaimed {
		t.Errorf("the second agent should be refused, got %v", err)
	}

	who, _ := store.ClaimedBy(ctx, "test-don-1")
	if who != "agent-a" {
		t.Errorf("wrong winner recorded: %s", who)
	}
}

func TestSimultaneousClaimsProduceOneWinner(t *testing.T) {
	// The real scenario: three phones buzz at once and two agents tap Accept in
	// the same second. Redis executes one command at a time, so there is no
	// window where both can create the key.
	store, _ := testStore(t)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners []string
	)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			agentID := "agent-" + string(rune('a'+n))
			if err := store.Claim(context.Background(), "test-don-race", agentID, time.Minute); err == nil {
				mu.Lock()
				winners = append(winners, agentID)
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()

	if len(winners) != 1 {
		t.Errorf("exactly one agent must win, got %d: %v", len(winners), winners)
	}
}

func TestClaimingRemovesTheDeadline(t *testing.T) {
	// Otherwise the watcher would re-offer a donation somebody is already
	// driving to collect.
	store, rdb := testStore(t)
	ctx := context.Background()

	if err := store.SaveState(ctx, sampleState("test-don-2", "agent-a"), time.Hour); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	if score := rdb.ZScore(ctx, DeadlinesKey, "test-don-2").Val(); score == 0 {
		t.Fatal("the deadline should be armed after saving state")
	}

	store.Claim(ctx, "test-don-2", "agent-a", time.Minute)

	if err := rdb.ZScore(ctx, DeadlinesKey, "test-don-2").Err(); err != redis.Nil {
		t.Error("the deadline should be gone once the donation is claimed")
	}
}

func TestUnclaimedDonationReportsNobody(t *testing.T) {
	store, _ := testStore(t)

	who, err := store.ClaimedBy(context.Background(), "test-don-nobody")
	if err != nil {
		t.Fatalf("ClaimedBy: %v", err)
	}
	if who != "" {
		t.Errorf("expected nobody, got %q", who)
	}
}

// ------------------------------------------------------------ declines

func TestDeclinesAccumulateAcrossRounds(t *testing.T) {
	store, _ := testStore(t)
	ctx := context.Background()

	store.Decline(ctx, "test-don-3", "agent-a", "agent-b")
	store.Decline(ctx, "test-don-3", "agent-c")

	declined, err := store.Declined(ctx, "test-don-3")
	if err != nil {
		t.Fatalf("Declined: %v", err)
	}
	if len(declined) != 3 {
		t.Errorf("expected 3 declined agents, got %d: %v", len(declined), declined)
	}
	// A set, so the same agent declining twice is not counted twice.
	store.Decline(ctx, "test-don-3", "agent-a")
	declined, _ = store.Declined(ctx, "test-don-3")
	if len(declined) != 3 {
		t.Errorf("a repeated decline should not grow the set, got %d", len(declined))
	}
}

func TestPendingResponsesCountsWhoHasNotAnsweredYet(t *testing.T) {
	store, _ := testStore(t)
	ctx := context.Background()

	batch := []string{"agent-a", "agent-b", "agent-c"}

	if n, _ := store.PendingResponses(ctx, "test-don-4", batch); n != 3 {
		t.Errorf("expected 3 pending, got %d", n)
	}

	store.Decline(ctx, "test-don-4", "agent-a")
	if n, _ := store.PendingResponses(ctx, "test-don-4", batch); n != 2 {
		t.Errorf("expected 2 pending after one decline, got %d", n)
	}

	store.Decline(ctx, "test-don-4", "agent-b", "agent-c")
	if n, _ := store.PendingResponses(ctx, "test-don-4", batch); n != 0 {
		t.Errorf("expected 0 pending once everyone answered, got %d", n)
	}
}

// ------------------------------------------------------------ deadlines

func TestSaveAndReadBackOfferState(t *testing.T) {
	store, _ := testStore(t)
	ctx := context.Background()

	original := sampleState("test-don-5", "agent-a", "agent-b")
	if err := store.SaveState(ctx, original, time.Hour); err != nil {
		t.Fatalf("SaveState: %v", err)
	}

	got, err := store.GetState(ctx, "test-don-5")
	if err != nil || got == nil {
		t.Fatalf("GetState: %v", err)
	}

	// Everything needed to re-score without going back to donation-service.
	if got.Category != original.Category || got.Round != 1 || got.RadiusKm != 5 {
		t.Errorf("state did not round-trip: %+v", got)
	}
	if got.Lat != original.Lat || got.Lng != original.Lng {
		t.Errorf("coordinates did not round-trip: %v %v", got.Lat, got.Lng)
	}
	if len(got.OfferedTo) != 2 {
		t.Errorf("offeredTo did not round-trip: %v", got.OfferedTo)
	}
	if got.TraceID != "test-trace" {
		t.Errorf("traceId did not round-trip: %q", got.TraceID)
	}
}

func TestDueNowReturnsOnlyExpiredOffers(t *testing.T) {
	store, _ := testStore(t)
	ctx := context.Background()

	expired := sampleState("test-don-expired", "agent-a")
	expired.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	store.SaveState(ctx, expired, time.Hour)

	store.SaveState(ctx, sampleState("test-don-fresh", "agent-b"), time.Hour)

	due, err := store.DueNow(ctx, time.Now().UTC(), 100)
	if err != nil {
		t.Fatalf("DueNow: %v", err)
	}

	found := map[string]bool{}
	for _, id := range due {
		found[id] = true
	}
	if !found["test-don-expired"] {
		t.Error("the expired offer should be due")
	}
	if found["test-don-fresh"] {
		t.Error("an offer with time left must not be swept")
	}
}

func TestTakeDeadlineSucceedsForOnlyOneCaller(t *testing.T) {
	// Multiple engine instances all poll the same set. ZREM returning 1 for
	// exactly one of them is what stops a single expiry producing several
	// timeout events.
	store, _ := testStore(t)
	ctx := context.Background()

	expired := sampleState("test-don-take", "agent-a")
	expired.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	store.SaveState(ctx, expired, time.Hour)

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		takes int
	)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if mine, err := store.TakeDeadline(context.Background(), "test-don-take"); err == nil && mine {
				mu.Lock()
				takes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if takes != 1 {
		t.Errorf("exactly one caller should take the deadline, got %d", takes)
	}
}

func TestReofferReplacesTheOldDeadlineRatherThanAddingOne(t *testing.T) {
	store, rdb := testStore(t)
	ctx := context.Background()

	store.SaveState(ctx, sampleState("test-don-6", "agent-a"), time.Hour)

	second := sampleState("test-don-6", "agent-b")
	second.Round = 2
	second.ExpiresAt = time.Now().UTC().Add(120 * time.Second)
	store.SaveState(ctx, second, time.Hour)

	// A sorted set holds each member once, so round 2's deadline replaces
	// round 1's instead of leaving a stale one to fire later.
	count := 0
	members, _ := rdb.ZRange(ctx, DeadlinesKey, 0, -1).Result()
	for _, m := range members {
		if m == "test-don-6" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one deadline for the donation, got %d", count)
	}

	state, _ := store.GetState(ctx, "test-don-6")
	if state.Round != 2 {
		t.Errorf("expected round 2 after the re-offer, got %d", state.Round)
	}
}

// ---------------------------------------------------------------- load

func TestIncrementAgentLoadWritesTheKeyScoringReads(t *testing.T) {
	// The same key agent-location-service owns, so the next scoring pass sees
	// the agent as busier.
	store, rdb := testStore(t)
	ctx := context.Background()

	if n, err := store.IncrementAgentLoad(ctx, "test-agent-1"); err != nil || n != 1 {
		t.Fatalf("IncrementAgentLoad: %v %v", n, err)
	}
	if n, _ := store.IncrementAgentLoad(ctx, "test-agent-1"); n != 2 {
		t.Errorf("expected load 2, got %d", n)
	}

	if v := rdb.Get(ctx, "agent:test-agent-1:load").Val(); v != "2" {
		t.Errorf("the shared load key was not written: %q", v)
	}
}

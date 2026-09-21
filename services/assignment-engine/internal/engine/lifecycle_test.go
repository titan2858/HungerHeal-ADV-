package engine

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"hungerheal/assignment-engine/internal/domain"
	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/offers"
)

// Phase 6: the offer lifecycle. Accepting, declining, timing out, re-scoring.
// Still no Redis and no Kafka - the fake offer store implements the semantics
// that matter (SETNX wins once, declines accumulate), so these tests describe
// behaviour rather than plumbing.

func timeoutEvent(donationID string, round int, offeredTo []string, radius float64) events.DonationTimeout {
	return events.DonationTimeout{
		EventID:    "timeout-evt-1",
		DonationID: donationID,
		DonorID:    "donor-1",
		Category:   domain.CategoryCooked,
		TraceID:    "trace-1",
		Round:      round,
		OfferedTo:  offeredTo,
		RadiusKm:   radius,
	}
}

// offerFirstRound runs round 1 and returns the engine, store and publisher.
func offerFirstRound(t *testing.T, cands *fakeCandidates) (*Engine, *fakeOfferStore, *fakePublisher) {
	t.Helper()

	store := newFakeOfferStore()
	pub := &fakePublisher{}
	eng := newEngineWithStore(cands, pub, store)

	if _, err := eng.Handle(context.Background(), createdEvent(domain.CategoryCooked)); err != nil {
		t.Fatalf("first round failed: %v", err)
	}
	return eng, store, pub
}

// --------------------------------------------------------- the claim race

func TestFirstAgentToAcceptWinsAndTheRestAreTurnedAway(t *testing.T) {
	// This is the race the parallel-offer design creates: three phones buzz at
	// once and two agents can tap Accept in the same second. Without a lock they
	// both drive to the same address.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0)},
	}}
	eng, _, _ := offerFirstRound(t, cands)

	if _, err := eng.Accept(context.Background(), "don-1", "a", "Agent A", "+91 1"); err != nil {
		t.Fatalf("the first agent should win: %v", err)
	}

	_, err := eng.Accept(context.Background(), "don-1", "b", "Agent B", "+91 2")
	if err != offers.ErrAlreadyClaimed {
		t.Errorf("the second agent should be told the donation is taken, got %v", err)
	}
}

func TestSimultaneousAcceptsProduceExactlyOneWinner(t *testing.T) {
	// The same thing under real concurrency, which is how it actually happens.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0)},
	}}
	eng, _, _ := offerFirstRound(t, cands)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners []string
	)

	for _, id := range []string{"a", "b", "c"} {
		wg.Add(1)
		go func(agentID string) {
			defer wg.Done()
			if _, err := eng.Accept(context.Background(), "don-1", agentID, "Agent", "+91 1"); err == nil {
				mu.Lock()
				winners = append(winners, agentID)
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()

	if len(winners) != 1 {
		t.Errorf("exactly one agent must win the race, got %d: %v", len(winners), winners)
	}
}

func TestAcceptingIncrementsTheAgentsLoadCounter(t *testing.T) {
	// The counter has to move before the next donation is scored, or an agent
	// who just accepted still looks idle and immediately wins another.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	eng, store, _ := offerFirstRound(t, cands)

	result, err := eng.Accept(context.Background(), "don-1", "a", "Agent A", "+91 1")
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}

	if result.AgentLoad != 1 {
		t.Errorf("expected load 1 after accepting, got %d", result.AgentLoad)
	}
	if store.loads["a"] != 1 {
		t.Errorf("the load counter was not incremented, got %d", store.loads["a"])
	}
}

func TestAcceptingPublishesDonationAccepted(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	eng, _, pub := offerFirstRound(t, cands)

	if _, err := eng.Accept(context.Background(), "don-1", "a", "Agent A", "+91 1"); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	last := pub.last()
	if last.topic != events.TopicDonationAccepted {
		t.Fatalf("expected donation.accepted, got %s", last.topic)
	}

	accepted := last.payload.(events.DonationAccepted)
	if accepted.AgentID != "a" {
		t.Errorf("wrong agent on the event: %s", accepted.AgentID)
	}
	// tracking-service needs the donor id to notify them who is coming.
	if accepted.DonorID != "donor-1" {
		t.Errorf("donorId missing from the accepted event")
	}
	if accepted.TraceID != "trace-1" {
		t.Errorf("traceId did not survive to donation.accepted")
	}
}

func TestAnAgentCannotAcceptADonationTheyWereNotOffered(t *testing.T) {
	// Without this check, any agent could claim any donation id they could
	// guess.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	eng, _, _ := offerFirstRound(t, cands)

	if _, err := eng.Accept(context.Background(), "don-1", "stranger", "Nobody", "+91 9"); err != ErrNotOffered {
		t.Errorf("expected ErrNotOffered, got %v", err)
	}
}

func TestAcceptingAnUnknownDonationReportsAnExpiredOffer(t *testing.T) {
	eng := newEngine(&fakeCandidates{}, &fakePublisher{})

	if _, err := eng.Accept(context.Background(), "no-such-donation", "a", "A", "+91 1"); err != ErrOfferExpired {
		t.Errorf("expected ErrOfferExpired, got %v", err)
	}
}

// ------------------------------------------------------------- declining

func TestDecliningRecordsTheAgentAndCountsTheRemainingBatch(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0)},
	}}
	eng, store, _ := offerFirstRound(t, cands)

	remaining, err := eng.Reject(context.Background(), "don-1", "a", "too far")
	if err != nil {
		t.Fatalf("Reject: %v", err)
	}
	if remaining != 2 {
		t.Errorf("expected 2 agents still to answer, got %d", remaining)
	}

	declined, _ := store.Declined(context.Background(), "don-1")
	if !declined["a"] {
		t.Error("the declining agent was not recorded")
	}
}

func TestWholeBatchDecliningTriggersAnImmediateRescore(t *testing.T) {
	// Waiting out the rest of a 90-second window when all three have already
	// said no is time the food spends going cold for nothing.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0)},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	for _, id := range []string{"a", "b", "c"} {
		if _, err := eng.Reject(context.Background(), "don-1", id, "busy"); err != nil {
			t.Fatalf("Reject(%s): %v", id, err)
		}
	}

	var sawTimeout bool
	for _, e := range pub.published {
		if e.topic == events.TopicDonationTimeout {
			sawTimeout = true
		}
	}
	if !sawTimeout {
		t.Error("the last decline should trigger a re-score without waiting for the deadline")
	}
}

func TestDecliningDoesNotRescoreWhileSomeoneStillHasTheOffer(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0)},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	eng.Reject(context.Background(), "don-1", "a", "busy")

	for _, e := range pub.published {
		if e.topic == events.TopicDonationTimeout {
			t.Error("re-scored too early - two agents were still deciding")
		}
	}
}

// -------------------------------------------------------- the timeout loop

func TestTimeoutReoffersToDifferentAgents(t *testing.T) {
	// The heart of Phase 6. Nothing about the top 3 changes between rounds, so
	// without the exclusion set the re-score would hand the donation straight
	// back to the agents who just ignored it.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {
			candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0),
			candidate("d", 3.0), candidate("e", 4.0),
		},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	firstRound := pub.last().payload.(events.DonationAssigned)
	firstBatch := []string{}
	for _, o := range firstRound.Offers {
		firstBatch = append(firstBatch, o.AgentID)
	}

	if _, err := eng.HandleTimeout(context.Background(),
		timeoutEvent("don-1", 1, firstBatch, 5)); err != nil {
		t.Fatalf("HandleTimeout: %v", err)
	}

	secondRound := pub.last().payload.(events.DonationAssigned)
	if secondRound.Round != 2 {
		t.Errorf("expected round 2, got %d", secondRound.Round)
	}

	for _, offer := range secondRound.Offers {
		for _, previous := range firstBatch {
			if offer.AgentID == previous {
				t.Errorf("agent %s was re-offered a donation they already ignored", offer.AgentID)
			}
		}
	}
	if len(secondRound.Offers) != 2 {
		t.Errorf("expected the 2 remaining agents to be offered, got %d", len(secondRound.Offers))
	}
}

func TestTimeoutIsIgnoredIfSomeoneAcceptedInTheMeantime(t *testing.T) {
	// The deadline and the accept can land in the same moment. Re-offering then
	// would send a second agent to a donation already being collected.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0)},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	if _, err := eng.Accept(context.Background(), "don-1", "a", "Agent A", "+91 1"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	before := len(pub.published)

	res, err := eng.HandleTimeout(context.Background(), timeoutEvent("don-1", 1, []string{"a", "b"}, 5))
	if err != nil {
		t.Fatalf("HandleTimeout: %v", err)
	}

	if !res.Assigned {
		t.Error("a claimed donation should be treated as settled")
	}
	if len(pub.published) != before {
		t.Error("nothing should have been published for a donation that was already accepted")
	}
}

func TestTimeoutResumesFromTheRadiusItLeftOffAt(t *testing.T) {
	// Every agent inside the previous radius is now excluded, so re-searching
	// that same small circle would just find nobody.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5:  {candidate("a", 0.5)},
		12: {candidate("a", 0.5), candidate("far", 9)},
	}}
	eng, _, _ := offerFirstRound(t, cands)

	cands.calls = nil
	if _, err := eng.HandleTimeout(context.Background(),
		timeoutEvent("don-1", 1, []string{"a"}, 5)); err != nil {
		t.Fatalf("HandleTimeout: %v", err)
	}

	if len(cands.calls) == 0 {
		t.Fatal("expected a re-search")
	}
	if cands.calls[0] != 5 {
		t.Errorf("the re-score should resume at the last radius (5km), started at %v", cands.calls[0])
	}
}

func TestGivingUpAfterTheMaximumRounds(t *testing.T) {
	// A city with a hundred agents would otherwise work through all of them one
	// batch at a time while the food goes cold. At some point "nobody is taking
	// this" is the honest answer.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5), candidate("b", 1.0)},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	// MaxRounds is 4 in the test engine, so a timeout on round 4 gives up.
	res, err := eng.HandleTimeout(context.Background(), timeoutEvent("don-1", 4, []string{"a", "b"}, 5))
	if err != nil {
		t.Fatalf("HandleTimeout: %v", err)
	}

	if res.Assigned {
		t.Error("expected the engine to give up, not re-offer")
	}
	if pub.last().topic != events.TopicDonationUnassigned {
		t.Fatalf("expected donation.unassigned, got %s", pub.last().topic)
	}

	unassigned := pub.last().payload.(events.DonationUnassigned)
	if unassigned.Reason != events.ReasonAllAgentsExhausted {
		t.Errorf("expected ALL_AGENTS_EXHAUSTED, got %s", unassigned.Reason)
	}
	// The donor is told, rather than left watching a spinner forever.
	if !unassigned.Retryable {
		t.Error("the donor should still be able to have this retried later")
	}
}

func TestRunningOutOfAgentsGivesTheExhaustedReason(t *testing.T) {
	// Distinct from "nobody is online here": everyone who IS here has already
	// turned this donation down, and waiting will not change that.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {candidate("a", 0.5)}, 12: {candidate("a", 0.5)},
		25: {candidate("a", 0.5)}, 50: {candidate("a", 0.5)},
	}}
	eng, _, pub := offerFirstRound(t, cands)

	if _, err := eng.HandleTimeout(context.Background(),
		timeoutEvent("don-1", 1, []string{"a"}, 5)); err != nil {
		t.Fatalf("HandleTimeout: %v", err)
	}

	unassigned, ok := pub.last().payload.(events.DonationUnassigned)
	if !ok {
		t.Fatalf("expected donation.unassigned, got %T", pub.last().payload)
	}
	if unassigned.Reason != events.ReasonAllAgentsExhausted {
		t.Errorf("expected ALL_AGENTS_EXHAUSTED, got %s", unassigned.Reason)
	}
}

func TestOfferStateIsSavedBeforeTheEventIsPublished(t *testing.T) {
	// Ordering matters: if the event went first and the process died before the
	// deadline was armed, three agents would hold an offer that nothing was
	// ever going to expire - a stalled donation with no timer and no error.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	store := newFakeOfferStore()
	store.saveErr = errSaveFailed
	pub := &fakePublisher{}

	eng := newEngineWithStore(cands, pub, store)
	_, err := eng.Handle(context.Background(), createdEvent(domain.CategoryCooked))

	if err == nil {
		t.Fatal("a failure to save offer state must fail the whole handling")
	}
	for _, e := range pub.published {
		if e.topic == events.TopicDonationAssigned {
			t.Error("donation.assigned was published even though the deadline could not be armed")
		}
	}
}

func TestTheOfferDeadlineIsArmedWhenOffersGoOut(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	_, store, _ := offerFirstRound(t, cands)

	deadline, ok := store.deadlines["don-1"]
	if !ok {
		t.Fatal("no deadline was armed for the offer")
	}
	// Cooked food gets 90 seconds.
	if d := time.Until(deadline); d > 95*time.Second || d < 80*time.Second {
		t.Errorf("deadline is %v away, expected about 90s", d)
	}
}

// ---------------------------------------------------------- the watcher

func TestWatcherPublishesTimeoutForAnExpiredOffer(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	_, store, pub := offerFirstRound(t, cands)

	// Wind the deadline back to simulate 90 seconds passing.
	store.deadlines["don-1"] = time.Now().UTC().Add(-time.Second)

	watcher := &Watcher{
		Store:     store,
		Publisher: pub,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		BatchSize: 10,
	}

	n, err := watcher.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 expired offer, got %d", n)
	}

	last := pub.last()
	if last.topic != events.TopicDonationTimeout {
		t.Fatalf("expected donation.timeout, got %s", last.topic)
	}

	evt := last.payload.(events.DonationTimeout)
	if len(evt.OfferedTo) != 1 || evt.OfferedTo[0] != "a" {
		t.Errorf("the timeout event should name who ignored it, got %v", evt.OfferedTo)
	}
	// The donor's original trace, so the re-offer shows up under the same trace
	// as the request that created the donation minutes earlier.
	if evt.TraceID != "trace-1" {
		t.Errorf("traceId did not carry into the timeout event: %q", evt.TraceID)
	}
}

func TestWatcherLeavesOffersThatHaveNotExpiredAlone(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	_, store, pub := offerFirstRound(t, cands)

	watcher := &Watcher{
		Store: store, Publisher: pub,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), BatchSize: 10,
	}

	n, _ := watcher.Sweep(context.Background())
	if n != 0 {
		t.Errorf("an offer with 90 seconds left should not be swept, got %d", n)
	}
}

func TestWatcherSkipsOffersThatWereAccepted(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	eng, store, pub := offerFirstRound(t, cands)

	eng.Accept(context.Background(), "don-1", "a", "Agent A", "+91 1")
	// Force an expired deadline even though it was accepted, which is what a
	// crash between claiming and clearing would leave behind.
	store.deadlines["don-1"] = time.Now().UTC().Add(-time.Second)

	watcher := &Watcher{
		Store: store, Publisher: pub,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), BatchSize: 10,
	}

	n, _ := watcher.Sweep(context.Background())
	if n != 0 {
		t.Errorf("an accepted donation must not be re-offered, swept %d", n)
	}
}

func TestWatcherTakesEachDeadlineOnlyOnce(t *testing.T) {
	// Every engine instance polls the same sorted set and will all see the same
	// overdue donation. Only the one that actually removes it should act.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 0.5)}}}
	_, store, pub := offerFirstRound(t, cands)

	store.deadlines["don-1"] = time.Now().UTC().Add(-time.Second)

	watcher := &Watcher{
		Store: store, Publisher: pub,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), BatchSize: 10,
	}

	first, _ := watcher.Sweep(context.Background())
	second, _ := watcher.Sweep(context.Background())

	if first != 1 || second != 0 {
		t.Errorf("one expiry should produce exactly one timeout event, got %d then %d", first, second)
	}
}

var errSaveFailed = &saveError{}

type saveError struct{}

func (e *saveError) Error() string { return "could not save offer state" }

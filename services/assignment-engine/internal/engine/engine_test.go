package engine

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"hungerheal/assignment-engine/internal/domain"
	"hungerheal/assignment-engine/internal/events"
)

// Fakes, not mocks of Redis and Kafka. The engine's job is a decision flow -
// widen the radius, rank, offer or give up with a reason - and that flow is
// worth testing without a broker anywhere near it.

type fakeCandidates struct {
	// byRadius lets a test say "nobody within 5km, two agents within 12km",
	// which is the only way to exercise radius expansion honestly.
	byRadius map[float64][]domain.Candidate
	err      error
	calls    []float64
}

func (f *fakeCandidates) FindWithin(_ context.Context, _, _, radiusKm float64, _ int) ([]domain.Candidate, error) {
	f.calls = append(f.calls, radiusKm)
	if f.err != nil {
		return nil, f.err
	}
	return f.byRadius[radiusKm], nil
}

type fakePublisher struct {
	published []publishedEvent
	err       error
}

type publishedEvent struct {
	topic   string
	key     string
	payload any
}

func (f *fakePublisher) Publish(_ context.Context, topic, key string, payload any, _, _ string) error {
	if f.err != nil {
		return f.err
	}
	f.published = append(f.published, publishedEvent{topic: topic, key: key, payload: payload})
	return nil
}

func (f *fakePublisher) last() publishedEvent {
	if len(f.published) == 0 {
		return publishedEvent{}
	}
	return f.published[len(f.published)-1]
}

func newEngine(c CandidateSource, p Publisher) *Engine {
	return newEngineWithStore(c, p, newFakeOfferStore())
}

func newEngineWithStore(c CandidateSource, p Publisher, store OfferStore) *Engine {
	return &Engine{
		Candidates:     c,
		Publisher:      p,
		Offers:         store,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		OfferBatchSize: 3,
		MaxCandidates:  100,
		MaxRounds:      4,
		StateTTL:       time.Hour,
	}
}

func ptr(v float64) *float64 { return &v }

func createdEvent(category string) events.DonationCreated {
	e := events.DonationCreated{
		EventID:    "evt-1",
		DonationID: "don-1",
		DonorID:    "donor-1",
		Category:   category,
		TraceID:    "trace-1",
	}
	e.Pickup.Address = "12 MG Road, Bengaluru"
	e.Pickup.Lat = ptr(12.9757)
	e.Pickup.Lng = ptr(77.6068)
	return e
}

func candidate(id string, distanceKm float64, categories ...string) domain.Candidate {
	if len(categories) == 0 {
		categories = domain.FoodCategories
	}
	return domain.Candidate{
		AgentID:    id,
		Name:       "Agent " + id,
		Phone:      "+91 9000000000",
		DistanceKm: distanceKm,
		Rating:     4.0,
		Available:  true,
		Capabilities: domain.Capabilities{
			VehicleType:           "MOTORCYCLE",
			HasInsulatedTransport: true,
			CategoriesHandled:     categories,
		},
	}
}

// ------------------------------------------------------- the happy path

func TestOffersTheTopThreeAgentsInOneEvent(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {
			candidate("a", 0.5), candidate("b", 1.0), candidate("c", 2.0),
			candidate("d", 3.0), candidate("e", 4.0),
		},
	}}
	pub := &fakePublisher{}

	res, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if !res.Assigned {
		t.Fatal("expected the donation to be assigned")
	}
	// Parallel offers: one event carrying three agents, not three events.
	if len(res.Offers) != 3 {
		t.Fatalf("expected 3 offers, got %d", len(res.Offers))
	}

	assigned, ok := pub.last().payload.(events.DonationAssigned)
	if !ok {
		t.Fatalf("expected a DonationAssigned payload, got %T", pub.last().payload)
	}
	if pub.last().topic != events.TopicDonationAssigned {
		t.Errorf("wrong topic: %s", pub.last().topic)
	}
	// Keyed by donationId so every event about this donation shares a partition.
	if pub.last().key != "don-1" {
		t.Errorf("event must be keyed by donationId, got %q", pub.last().key)
	}
	if assigned.Offers[0].Rank != 1 || assigned.Offers[2].Rank != 3 {
		t.Error("offers should be ranked 1..3")
	}
	if assigned.Offers[0].Score < assigned.Offers[1].Score {
		t.Error("offers are not ordered best-first")
	}
}

func TestOfferCarriesTheScoreBreakdown(t *testing.T) {
	// Phase 10's monitoring view has to show WHY. Recomputing the reasoning
	// later would mean reading agent state that has since changed, so it
	// travels with the offer.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 1.0)}}}
	pub := &fakePublisher{}

	_, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	offer := pub.last().payload.(events.DonationAssigned).Offers[0]
	b := offer.Breakdown

	if b.DistanceScore == 0 || b.CategoryScore == 0 || b.LoadScore == 0 || b.RatingScore == 0 {
		t.Errorf("breakdown is incomplete: %+v", b)
	}
	sum := b.WeightedDistance + b.WeightedCategory + b.WeightedLoad + b.WeightedRating
	if diff := b.Total - sum; diff > 1e-4 || diff < -1e-4 {
		t.Errorf("breakdown does not add up: total %v vs parts %v", b.Total, sum)
	}
	if b.ScorePercent <= 0 {
		t.Error("expected a human-readable percentage on the breakdown")
	}
}

func TestFewerThanThreeAgentsStillProducesOffers(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("only", 1.0)}}}
	pub := &fakePublisher{}

	res, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryBakery))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !res.Assigned || len(res.Offers) != 1 {
		t.Errorf("one agent should still be offered the donation, got %+v", res)
	}
}

// --------------------------------------------------- radius expansion

func TestWidensTheRadiusUntilAgentsAreFound(t *testing.T) {
	// Nobody within 5km or 12km; two agents at 25km.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5:  {},
		12: {},
		25: {candidate("far-a", 20), candidate("far-b", 23)},
	}}
	pub := &fakePublisher{}

	res, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if !res.Assigned {
		t.Fatal("expected assignment after widening the search")
	}
	if res.RadiusAttempts != 3 {
		t.Errorf("expected 3 radius attempts, got %d", res.RadiusAttempts)
	}
	if res.RadiusUsedKm != 25 {
		t.Errorf("expected the 25km rung to be used, got %v", res.RadiusUsedKm)
	}
	// Must try nearest first - finding a closer agent is always preferable.
	if cands.calls[0] != 5 {
		t.Errorf("the search must start at 5km, started at %v", cands.calls[0])
	}
}

func TestStopsWideningAsSoonAsSomeoneIsFound(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5:  {candidate("near", 2)},
		12: {candidate("far", 10)},
	}}
	pub := &fakePublisher{}

	res, _ := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))

	if res.RadiusAttempts != 1 {
		t.Errorf("should have stopped after the first radius, made %d attempts", res.RadiusAttempts)
	}
	if len(cands.calls) != 1 {
		t.Errorf("expected exactly 1 lookup, got %v", cands.calls)
	}
}

func TestUrgentFoodUsesTheWiderLadder(t *testing.T) {
	// The ladders differ by urgency: hot food jumps 5 -> 12 -> 25, tinned goods
	// creep 5 -> 8 -> 12.
	cooked := &fakeCandidates{byRadius: map[float64][]domain.Candidate{}}
	newEngine(cooked, &fakePublisher{}).Handle(context.Background(), createdEvent(domain.CategoryCooked))

	packaged := &fakeCandidates{byRadius: map[float64][]domain.Candidate{}}
	newEngine(packaged, &fakePublisher{}).Handle(context.Background(), createdEvent(domain.CategoryPackaged))

	if cooked.calls[1] <= packaged.calls[1] {
		t.Errorf("urgent food should widen faster: cooked %v vs packaged %v",
			cooked.calls, packaged.calls)
	}
}

// ------------------------------------------------------ the unhappy paths

func TestDonationWithoutCoordinatesIsPublishedAsUnassigned(t *testing.T) {
	evt := createdEvent(domain.CategoryBakery)
	evt.Pickup.Lat = nil
	evt.Pickup.Lng = nil

	cands := &fakeCandidates{}
	pub := &fakePublisher{}

	res, err := newEngine(cands, pub).Handle(context.Background(), evt)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if res.Assigned {
		t.Error("a donation with no coordinates cannot be assigned")
	}
	// No point searching around a location that does not exist.
	if len(cands.calls) != 0 {
		t.Errorf("should not have searched at all, made %d lookups", len(cands.calls))
	}

	unassigned := pub.last().payload.(events.DonationUnassigned)
	if unassigned.Reason != events.ReasonNotGeocoded {
		t.Errorf("wrong reason: %s", unassigned.Reason)
	}
	// Waiting will not geocode it; retrying is pointless until it is.
	if unassigned.Retryable {
		t.Error("an ungeocoded donation should not be marked retryable")
	}
}

func TestNoAgentsAnywhereIsPublishedNotDropped(t *testing.T) {
	// The plan is explicit: a donation must never silently disappear.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{}}
	pub := &fakePublisher{}

	res, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if res.Assigned {
		t.Error("expected no assignment")
	}
	if len(pub.published) != 1 || pub.last().topic != events.TopicDonationUnassigned {
		t.Fatalf("expected a donation.unassigned event, got %+v", pub.published)
	}

	unassigned := pub.last().payload.(events.DonationUnassigned)
	if unassigned.Reason != events.ReasonNoAgentsFound {
		t.Errorf("wrong reason: %s", unassigned.Reason)
	}
	// Agents come online continuously, so this one IS worth retrying.
	if !unassigned.Retryable {
		t.Error("no-agents-found should be retryable")
	}
	if res.RadiusAttempts != len(cands.calls) || res.RadiusAttempts != 4 {
		t.Errorf("expected all 4 rungs of the ladder to be tried, got %d", res.RadiusAttempts)
	}
}

func TestAgentsNearbyButNoneEligibleGivesADifferentReason(t *testing.T) {
	// "Nobody is online here" and "three agents are nearby but none carry
	// cooked food" need different answers - the second will not fix itself by
	// waiting for more agents of the same kind.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5:  {candidate("packaged-only", 1, domain.CategoryPackaged)},
		12: {candidate("packaged-only", 1, domain.CategoryPackaged)},
		25: {candidate("packaged-only", 1, domain.CategoryPackaged)},
		50: {candidate("packaged-only", 1, domain.CategoryPackaged)},
	}}
	pub := &fakePublisher{}

	_, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	unassigned := pub.last().payload.(events.DonationUnassigned)
	if unassigned.Reason != events.ReasonNoEligibleAgents {
		t.Errorf("expected NO_ELIGIBLE_AGENTS, got %s", unassigned.Reason)
	}
	if unassigned.CandidatesFound == 0 {
		t.Error("the event should record that agents WERE found, just not eligible ones")
	}
}

func TestUnavailableAgentsAreNotOffered(t *testing.T) {
	busy := candidate("busy", 1)
	busy.Available = false

	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {busy}, 12: {busy}, 25: {busy}, 50: {busy},
	}}
	pub := &fakePublisher{}

	res, _ := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if res.Assigned {
		t.Error("an agent who is not accepting work must not be offered a donation")
	}
}

// ------------------------------------------------------ failure handling

func TestRedisFailureIsAnErrorNotAWrongAnswer(t *testing.T) {
	// This distinction is the important one. Treating a lookup failure as
	// "no agents found" would publish a false answer AND commit the Kafka
	// offset, permanently losing a donation that was perfectly placeable.
	cands := &fakeCandidates{err: errors.New("redis is down")}
	pub := &fakePublisher{}

	_, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))

	if err == nil {
		t.Fatal("a candidate-lookup failure must surface as an error")
	}
	if len(pub.published) != 0 {
		t.Errorf("nothing should be published when the lookup failed, got %+v", pub.published)
	}
}

func TestPublishFailureSurfacesAsAnError(t *testing.T) {
	// So the caller does not commit the offset, and the donation is retried.
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 1)}}}
	pub := &fakePublisher{err: errors.New("kafka is down")}

	_, err := newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	if err == nil {
		t.Fatal("a publish failure must surface as an error")
	}
}

// ------------------------------------------------------------- urgency

func TestTheOfferCarriesAnUrgencyDrivenTimeout(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 1)}}}

	pubCooked := &fakePublisher{}
	newEngine(cands, pubCooked).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	cooked := pubCooked.last().payload.(events.DonationAssigned)

	pubTinned := &fakePublisher{}
	newEngine(cands, pubTinned).Handle(context.Background(), createdEvent(domain.CategoryPackaged))
	tinned := pubTinned.last().payload.(events.DonationAssigned)

	if cooked.ResponseTimeoutSeconds != 90 {
		t.Errorf("cooked food should get a 90s window, got %d", cooked.ResponseTimeoutSeconds)
	}
	if tinned.ResponseTimeoutSeconds <= cooked.ResponseTimeoutSeconds {
		t.Error("tinned goods should get a longer response window than hot food")
	}
	if cooked.Urgency != "HIGH" {
		t.Errorf("expected HIGH urgency for cooked food, got %s", cooked.Urgency)
	}
}

func TestTheAssignedEventCarriesTheSearchStory(t *testing.T) {
	// So a human can tell "the best agent in the city" from "the only agent we
	// could find after widening three times".
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{
		5: {}, 12: {}, 25: {candidate("far", 22)},
	}}
	pub := &fakePublisher{}

	newEngine(cands, pub).Handle(context.Background(), createdEvent(domain.CategoryCooked))
	assigned := pub.last().payload.(events.DonationAssigned)

	if assigned.RadiusAttempts != 3 || assigned.SearchRadiusKm != 25 {
		t.Errorf("search story is wrong: %d attempts at %vkm",
			assigned.RadiusAttempts, assigned.SearchRadiusKm)
	}
	if assigned.CandidatesEligible != 1 {
		t.Errorf("expected 1 eligible candidate recorded, got %d", assigned.CandidatesEligible)
	}
}

func TestTraceIdFlowsFromTheIncomingEventToTheOutgoingOne(t *testing.T) {
	cands := &fakeCandidates{byRadius: map[float64][]domain.Candidate{5: {candidate("a", 1)}}}
	pub := &fakePublisher{}

	evt := createdEvent(domain.CategoryCooked)
	evt.TraceID = "trace-from-donor-request"

	newEngine(cands, pub).Handle(context.Background(), evt)

	if got := pub.last().payload.(events.DonationAssigned).TraceID; got != "trace-from-donor-request" {
		t.Errorf("traceId did not propagate: %q", got)
	}
}

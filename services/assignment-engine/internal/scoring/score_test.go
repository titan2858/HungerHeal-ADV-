package scoring

import (
	"math"
	"testing"

	"hungerheal/assignment-engine/internal/domain"
)

// These tests use fabricated numbers and touch no infrastructure at all. They
// run with Docker stopped. That is the entire reason the scoring package has no
// dependencies: a failure here means the ALGORITHM is wrong, never that a
// broker was slow or a Redis key was missing.

const epsilon = 1e-9

func approx(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 1e-4 {
		t.Errorf("%s: got %v, want %v", label, got, want)
	}
}

func agent(id string, opts ...func(*domain.Candidate)) domain.Candidate {
	c := domain.Candidate{
		AgentID:     id,
		Name:        "Agent " + id,
		DistanceKm:  1,
		Rating:      NeutralRating,
		CurrentLoad: 0,
		Available:   true,
		Capabilities: domain.Capabilities{
			VehicleType:       "MOTORCYCLE",
			CategoriesHandled: domain.FoodCategories,
		},
	}
	for _, o := range opts {
		o(&c)
	}
	return c
}

func at(km float64) func(*domain.Candidate)   { return func(c *domain.Candidate) { c.DistanceKm = km } }
func load(n int) func(*domain.Candidate)      { return func(c *domain.Candidate) { c.CurrentLoad = n } }
func rated(r float64) func(*domain.Candidate) { return func(c *domain.Candidate) { c.Rating = r } }
func insulated() func(*domain.Candidate) {
	return func(c *domain.Candidate) { c.Capabilities.HasInsulatedTransport = true }
}
func refrigerated() func(*domain.Candidate) {
	return func(c *domain.Candidate) { c.Capabilities.HasRefrigeration = true }
}
func handles(cats ...string) func(*domain.Candidate) {
	return func(c *domain.Candidate) { c.Capabilities.CategoriesHandled = cats }
}
func unavailable() func(*domain.Candidate) {
	return func(c *domain.Candidate) { c.Available = false }
}

func donation(category string) domain.Donation {
	return domain.Donation{DonationID: "d1", Category: category, Lat: 12.9757, Lng: 77.6068}
}

// ------------------------------------------------------- normalisation

func TestEveryTermIsNormalisedToZeroOne(t *testing.T) {
	// The rule that makes the weights mean anything. If any term could exceed
	// 1, its weight would no longer describe its share of the decision.
	cases := []struct {
		name string
		got  float64
	}{
		{"distance at zero km", DistanceScore(0, 5)},
		{"distance at the radius edge", DistanceScore(5, 5)},
		{"distance beyond the radius", DistanceScore(500, 5)},
		{"load of zero", LoadScore(0)},
		{"load of one hundred", LoadScore(100)},
		{"load negative (corrupt counter)", LoadScore(-5)},
		{"rating of five", RatingScore(5)},
		{"rating of zero", RatingScore(0)},
		{"compatibility best case", CategoryCompatibility(domain.CategoryCooked, domain.Capabilities{HasInsulatedTransport: true})},
		{"compatibility worst case", CategoryCompatibility(domain.CategoryCooked, domain.Capabilities{})},
	}

	for _, c := range cases {
		if c.got < 0-epsilon || c.got > 1+epsilon {
			t.Errorf("%s produced %v, which is outside 0..1", c.name, c.got)
		}
	}
}

func TestWeightsSumToTheDocumentedMaximum(t *testing.T) {
	// The plan's weights sum to 0.95, not 1.0. Keeping them exactly as
	// specified means the best possible score is 0.95 - which changes no
	// ranking, since every candidate is scaled by the same constant. This test
	// pins that the constant and the weights cannot drift apart.
	total := WeightDistance + WeightCategory + WeightLoad + WeightRating
	approx(t, total, 0.95, "sum of the plan's weights")
	approx(t, MaxPossibleScore, total, "MaxPossibleScore tracks the weights")
}

func TestTotalScoreNeverExceedsTheMaximum(t *testing.T) {
	// The theoretical best: at the pickup point, ideal transport, idle, 5.0.
	perfect := ScoreAgent(
		donation(domain.CategoryCooked),
		agent("perfect", at(0), load(0), rated(5), insulated()),
		5,
	)
	if perfect.Score > MaxPossibleScore+epsilon {
		t.Errorf("a perfect agent scored %v, above the maximum %v", perfect.Score, MaxPossibleScore)
	}
	approx(t, perfect.Score, MaxPossibleScore, "perfect agent")
	// Shown to humans as 100%, so nobody has to know the raw scale.
	approx(t, perfect.Breakdown.ScorePercent, 100, "perfect agent as a percentage")
}

// ------------------------------------------------------------- distance

func TestDistanceScoreFallsOffLinearly(t *testing.T) {
	approx(t, DistanceScore(0, 10), 1.0, "at the pickup point")
	approx(t, DistanceScore(5, 10), 0.5, "halfway to the edge")
	approx(t, DistanceScore(10, 10), 0.0, "at the edge")
}

func TestDistanceScoreIsBoundedNotInverse(t *testing.T) {
	// The spec's literal 1/normalized_distance would be infinite here, and one
	// infinite term makes the other three irrelevant forever.
	s := DistanceScore(0.0001, 5)
	if math.IsInf(s, 0) || s > 1 {
		t.Errorf("a near-zero distance produced %v; the term must stay bounded", s)
	}
}

func TestDistanceBeyondRadiusClampsToZeroRatherThanGoingNegative(t *testing.T) {
	// A negative term would actively subtract from the other three, which is a
	// different thing from "contributes nothing".
	if got := DistanceScore(50, 5); got != 0 {
		t.Errorf("distance beyond the radius scored %v, want 0", got)
	}
}

func TestCloserAgentBeatsFartherWhenAllElseIsEqual(t *testing.T) {
	d := donation(domain.CategoryBakery)
	near := ScoreAgent(d, agent("near", at(1)), 10)
	far := ScoreAgent(d, agent("far", at(8)), 10)

	if near.Score <= far.Score {
		t.Errorf("nearer agent scored %v, not better than farther agent's %v", near.Score, far.Score)
	}
}

// ----------------------------------------------------------------- load

func TestLoadScoreMatchesTheSpecCurve(t *testing.T) {
	approx(t, LoadScore(0), 1.0, "idle agent")
	approx(t, LoadScore(1), 0.5, "one pending pickup")
	approx(t, LoadScore(3), 0.25, "three pending pickups")
}

func TestLoadSpreadsWorkInsteadOfStackingItOnOneAgent(t *testing.T) {
	// The reason the load term exists at all: without it, the single best agent
	// wins every donation in the area while everyone else sits idle.
	d := donation(domain.CategoryBakery)

	busyButCloser := ScoreAgent(d, agent("busy", at(1), load(4)), 10)
	idleButFarther := ScoreAgent(d, agent("idle", at(4), load(0)), 10)

	if idleButFarther.Score <= busyButCloser.Score {
		t.Errorf("an idle agent 4km away (%v) should beat an agent 1km away carrying 4 jobs (%v)",
			idleButFarther.Score, busyButCloser.Score)
	}
}

func TestLoadDoesNotOverrideAVeryLargeDistanceAdvantage(t *testing.T) {
	// Load matters, but it is 0.20 against distance's 0.35. A nearby agent with
	// one job should still beat an idle agent at the very edge of the radius.
	d := donation(domain.CategoryBakery)

	nearWithOneJob := ScoreAgent(d, agent("near", at(0.5), load(1)), 20)
	idleAtTheEdge := ScoreAgent(d, agent("edge", at(19.5), load(0)), 20)

	if nearWithOneJob.Score <= idleAtTheEdge.Score {
		t.Errorf("load term is overpowering distance: near-with-one-job %v vs idle-at-edge %v",
			nearWithOneJob.Score, idleAtTheEdge.Score)
	}
}

// --------------------------------------------------------------- rating

func TestNewAgentWithNeutralRatingIsCompetitive(t *testing.T) {
	// A new agent is seeded at 3.5, not 0. If a zero rating were possible they
	// would lose every contest and never get the work needed to earn a rating.
	d := donation(domain.CategoryBakery)

	newAgent := ScoreAgent(d, agent("new", at(1), rated(NeutralRating)), 10)
	veteran := ScoreAgent(d, agent("vet", at(3), rated(5.0)), 10)

	if newAgent.Score <= veteran.Score {
		t.Errorf("a closer new agent (%v) should still beat a farther 5-star veteran (%v)",
			newAgent.Score, veteran.Score)
	}
}

func TestRatingBreaksTiesButDoesNotDominate(t *testing.T) {
	d := donation(domain.CategoryBakery)

	good := ScoreAgent(d, agent("good", at(2), rated(5.0)), 10)
	poor := ScoreAgent(d, agent("poor", at(2), rated(2.0)), 10)

	if good.Score <= poor.Score {
		t.Error("with everything else equal, the better-rated agent should win")
	}

	// But 0.15 of the score cannot outweigh a LARGE distance advantage.
	//
	// The gap has to be genuinely large for this to hold, and that is correct
	// rather than a weakness: at 2km vs 0.5km inside a 10km radius the distance
	// difference is only 0.0525 of the score, while a 2.0-vs-5.0 rating gap is
	// worth 0.09 - so the far, reliable agent SHOULD win that one. Unreliability
	// is worth a short detour. It is not worth a long one.
	closeAndPoorlyRated := ScoreAgent(d, agent("close-poor", at(0.5), rated(2.0)), 10)
	farButWellRated := ScoreAgent(d, agent("far-good", at(8.0), rated(5.0)), 10)

	if closeAndPoorlyRated.Score <= farButWellRated.Score {
		t.Errorf("rating is overpowering distance: an agent 0.5km away rated 2.0 (%v) "+
			"must beat one 8km away rated 5.0 (%v)",
			closeAndPoorlyRated.Score, farButWellRated.Score)
	}

	// And the boundary case, asserted explicitly so the balance between the two
	// terms is pinned rather than assumed: at only 1.5km apart the better-rated
	// agent DOES win, because 0.15 of rating outweighs 0.0525 of distance.
	// A short detour for a reliable agent is the intended behaviour.
	if good.Score <= closeAndPoorlyRated.Score {
		t.Errorf("over a short distance the reliable agent should win: "+
			"far-good %v vs close-poor %v", good.Score, closeAndPoorlyRated.Score)
	}
}

func TestCorruptZeroRatingIsTreatedAsNeutralNotCatastrophic(t *testing.T) {
	approx(t, RatingScore(0), NeutralRating/MaxRating, "zero rating falls back to neutral")
}

// -------------------------------------------------------- compatibility

func TestInsulatedTransportWinsForCookedFood(t *testing.T) {
	withBox := CategoryCompatibility(domain.CategoryCooked, domain.Capabilities{HasInsulatedTransport: true})
	without := CategoryCompatibility(domain.CategoryCooked, domain.Capabilities{})

	if withBox <= without {
		t.Errorf("insulated (%v) should beat bare transport (%v) for cooked food", withBox, without)
	}
}

func TestRefrigerationWinsForRawPerishables(t *testing.T) {
	fridge := CategoryCompatibility(domain.CategoryPerishRaw, domain.Capabilities{HasRefrigeration: true})
	box := CategoryCompatibility(domain.CategoryPerishRaw, domain.Capabilities{HasInsulatedTransport: true})

	if fridge <= box {
		t.Errorf("refrigeration (%v) should beat insulation (%v) for raw perishables", fridge, box)
	}
}

func TestMismatchIsPenalisedButNeverZeroed(t *testing.T) {
	// The plan is explicit: a strict mismatch must not zero out every
	// candidate, or in an area with no specialised agents the ranking degrades
	// to picking at random among equally-zero scores.
	worst := CategoryCompatibility(domain.CategoryCooked, domain.Capabilities{})
	if worst <= 0 {
		t.Errorf("worst-case compatibility was %v; it must stay above zero", worst)
	}
	if worst >= 0.6 {
		t.Errorf("worst-case compatibility was %v; it should still be a real penalty", worst)
	}
}

func TestSpecialisedAgentsAreSavedForFoodThatNeedsThem(t *testing.T) {
	// An insulated agent scores LOWER on dry packaged goods than a plain one.
	// Without this, specialised agents win everything and are all busy carrying
	// tins when a hot meal appears.
	specialised := CategoryCompatibility(domain.CategoryPackaged, domain.Capabilities{HasInsulatedTransport: true})
	plain := CategoryCompatibility(domain.CategoryPackaged, domain.Capabilities{})

	if specialised >= plain {
		t.Errorf("for dry goods, a specialised agent (%v) should not outrank a plain one (%v)",
			specialised, plain)
	}
}

func TestPlainAgentIsAPerfectMatchForBakery(t *testing.T) {
	approx(t, CategoryCompatibility(domain.CategoryBakery, domain.Capabilities{}), 1.0,
		"bread needs no special transport")
}

func TestUnknownCategoryGetsNeutralCompatibility(t *testing.T) {
	got := CategoryCompatibility("SUSHI", domain.Capabilities{})
	if got <= 0 || got >= 1 {
		t.Errorf("unknown category scored %v; expected a neutral middle value", got)
	}
}

// -------------------------------------------------------------- ranking

func TestRankAgentsOrdersBestFirst(t *testing.T) {
	d := donation(domain.CategoryCooked)

	candidates := []domain.Candidate{
		agent("far-plain", at(4.5)),
		agent("near-insulated", at(0.5), insulated()),
		agent("mid-insulated", at(2.5), insulated()),
	}

	ranked := RankAgents(d, candidates, 5, nil)

	if len(ranked) != 3 {
		t.Fatalf("expected 3 ranked agents, got %d", len(ranked))
	}
	if ranked[0].Candidate.AgentID != "near-insulated" {
		t.Errorf("expected near-insulated first, got %s", ranked[0].Candidate.AgentID)
	}
	for i := 1; i < len(ranked); i++ {
		if ranked[i-1].Score < ranked[i].Score {
			t.Errorf("ranking is not descending at position %d", i)
		}
	}
}

func TestRankAgentsExcludesAgentsWhoDoNotHandleTheCategory(t *testing.T) {
	d := donation(domain.CategoryCooked)

	candidates := []domain.Candidate{
		// Right next door, but does not carry cooked food. A score penalty
		// would still let them win here, since they are the closest.
		agent("packaged-only", at(0.1), handles(domain.CategoryPackaged)),
		agent("cooked-ok", at(4), handles(domain.CategoryCooked)),
	}

	ranked := RankAgents(d, candidates, 5, nil)

	if len(ranked) != 1 {
		t.Fatalf("expected 1 eligible agent, got %d", len(ranked))
	}
	if ranked[0].Candidate.AgentID != "cooked-ok" {
		t.Errorf("wrong agent survived the filter: %s", ranked[0].Candidate.AgentID)
	}
}

func TestRankAgentsExcludesUnavailableAgents(t *testing.T) {
	d := donation(domain.CategoryBakery)
	ranked := RankAgents(d, []domain.Candidate{agent("off", at(0.2), unavailable())}, 5, nil)

	if len(ranked) != 0 {
		t.Errorf("an unavailable agent must not be ranked, got %d", len(ranked))
	}
}

func TestRankAgentsExcludesAgentsWhoAlreadyDeclined(t *testing.T) {
	// After a timeout the donation is re-scored. Without this, the re-score
	// hands it straight back to whoever just ignored it, and the donation
	// bounces between the same agents until it expires.
	d := donation(domain.CategoryBakery)

	candidates := []domain.Candidate{
		agent("declined", at(0.5)),
		agent("fresh", at(3)),
	}

	ranked := RankAgents(d, candidates, 5, map[string]bool{"declined": true})

	if len(ranked) != 1 || ranked[0].Candidate.AgentID != "fresh" {
		t.Errorf("expected only the fresh agent, got %+v", ranked)
	}
}

func TestRankingIsDeterministicForIdenticalAgents(t *testing.T) {
	// Two agents identical in every scored respect. The order must still be
	// stable across runs - a ranking that depends on map iteration order is
	// nearly impossible to debug from logs.
	d := donation(domain.CategoryBakery)
	candidates := []domain.Candidate{agent("bbb", at(2)), agent("aaa", at(2))}

	first := RankAgents(d, candidates, 5, nil)
	for i := 0; i < 20; i++ {
		again := RankAgents(d, candidates, 5, nil)
		if again[0].Candidate.AgentID != first[0].Candidate.AgentID {
			t.Fatal("ranking is not deterministic between runs")
		}
	}
	if first[0].Candidate.AgentID != "aaa" {
		t.Errorf("expected the id tie-break to put aaa first, got %s", first[0].Candidate.AgentID)
	}
}

func TestTopNTakesTheBestThree(t *testing.T) {
	d := donation(domain.CategoryBakery)

	candidates := []domain.Candidate{
		agent("a", at(1)), agent("b", at(2)), agent("c", at(3)),
		agent("d", at(4)), agent("e", at(4.5)),
	}

	top := TopN(RankAgents(d, candidates, 5, nil), 3)

	if len(top) != 3 {
		t.Fatalf("expected 3 offers, got %d", len(top))
	}
	if top[0].Candidate.AgentID != "a" || top[2].Candidate.AgentID != "c" {
		t.Errorf("wrong agents selected: %s, %s, %s",
			top[0].Candidate.AgentID, top[1].Candidate.AgentID, top[2].Candidate.AgentID)
	}
}

func TestTopNHandlesFewerCandidatesThanRequested(t *testing.T) {
	d := donation(domain.CategoryBakery)
	top := TopN(RankAgents(d, []domain.Candidate{agent("only", at(1))}, 5, nil), 3)

	if len(top) != 1 {
		t.Errorf("expected 1 offer when only 1 agent exists, got %d", len(top))
	}
}

func TestTopNOnAnEmptyRankingReturnsEmptyNotNil(t *testing.T) {
	// A nil slice here would serialise as `null` in the event payload and make
	// consumers branch on it separately from an empty list.
	top := TopN([]ScoredAgent{}, 3)
	if top == nil || len(top) != 0 {
		t.Errorf("expected an empty slice, got %#v", top)
	}
}

// ------------------------------------------------------------ breakdown

func TestBreakdownExplainsTheDecision(t *testing.T) {
	// The monitoring view in Phase 10 must show WHY an agent was chosen.
	// "The system decided" is not an acceptable answer to a donor whose food
	// went to the wrong person.
	s := ScoreAgent(
		donation(domain.CategoryCooked),
		agent("a", at(2), load(1), rated(4.0), insulated()),
		10,
	)
	b := s.Breakdown

	approx(t, b.DistanceScore, 0.8, "distance score") // 1 - 2/10
	approx(t, b.CategoryScore, 1.0, "category score") // insulated + cooked
	approx(t, b.LoadScore, 0.5, "load score")         // 1/(1+1)
	approx(t, b.RatingScore, 0.8, "rating score")     // 4.0/5

	approx(t, b.WeightedDistance, 0.28, "weighted distance") // 0.8  * 0.35
	approx(t, b.WeightedCategory, 0.25, "weighted category") // 1.0  * 0.25
	approx(t, b.WeightedLoad, 0.10, "weighted load")         // 0.5  * 0.20
	approx(t, b.WeightedRating, 0.12, "weighted rating")     // 0.8  * 0.15

	// The parts must add up to the whole, or the explanation is a fiction.
	sum := b.WeightedDistance + b.WeightedCategory + b.WeightedLoad + b.WeightedRating
	approx(t, b.Total, sum, "total equals the sum of its weighted parts")
	approx(t, s.Score, 0.75, "total score")
}

// -------------------------------------------------------------- urgency

func TestUrgencyDrivesTimeoutNotScore(t *testing.T) {
	// Same agent, two categories with very different urgency. The urgency must
	// not leak into the score.
	cooked := ScoreAgent(donation(domain.CategoryCooked), agent("a", at(2), insulated()), 10)
	packaged := ScoreAgent(donation(domain.CategoryPackaged), agent("a", at(2), insulated()), 10)

	// They differ only through the compatibility matrix, never through urgency.
	if cooked.Breakdown.DistanceScore != packaged.Breakdown.DistanceScore {
		t.Error("urgency leaked into the distance term")
	}
	if cooked.Breakdown.LoadScore != packaged.Breakdown.LoadScore {
		t.Error("urgency leaked into the load term")
	}
	if cooked.Breakdown.RatingScore != packaged.Breakdown.RatingScore {
		t.Error("urgency leaked into the rating term")
	}

	// Where it DOES show up:
	if ResponseTimeout(domain.CategoryCooked) >= ResponseTimeout(domain.CategoryPackaged) {
		t.Error("cooked food should get a shorter response window than tinned goods")
	}
}

func TestPerishableCategoriesGetTheShortWindow(t *testing.T) {
	for _, c := range []string{domain.CategoryCooked, domain.CategoryPerishRaw} {
		if UrgencyOf(c) != UrgencyHigh {
			t.Errorf("%s should be high urgency", c)
		}
		if ResponseTimeout(c) != 90*1e9 {
			t.Errorf("%s should get a 90s response window, got %v", c, ResponseTimeout(c))
		}
	}
}

func TestUnknownCategoryIsTreatedAsUrgent(t *testing.T) {
	// If the guess is wrong the cost is a hurried reassignment. The opposite
	// mistake lets food spoil while the system waits patiently.
	if UrgencyOf("SUSHI") != UrgencyHigh {
		t.Error("an unknown category should default to urgent")
	}
}

func TestRadiusLadderStartsAtFiveAndWidens(t *testing.T) {
	for _, c := range domain.FoodCategories {
		ladder := RadiusLadderKm(c)
		if ladder[0] != 5 {
			t.Errorf("%s ladder should start at 5km, got %v", c, ladder[0])
		}
		for i := 1; i < len(ladder); i++ {
			if ladder[i] <= ladder[i-1] {
				t.Errorf("%s ladder is not strictly widening: %v", c, ladder)
			}
		}
	}
}

func TestUrgentFoodSearchesWiderFaster(t *testing.T) {
	// A cooling meal is better served by an agent 25km away who says yes now
	// than by a perfect match found after four patient rounds.
	urgent := RadiusLadderKm(domain.CategoryCooked)
	patient := RadiusLadderKm(domain.CategoryPackaged)

	if urgent[1] <= patient[1] {
		t.Errorf("urgent food should widen faster: %v vs %v", urgent, patient)
	}
	if MaxRadiusKm(domain.CategoryCooked) <= MaxRadiusKm(domain.CategoryPackaged) {
		t.Error("urgent food should be willing to search farther in the end")
	}
}

// ------------------------------------------------- realistic end-to-end

func TestRealisticScenarioCookedFoodInBengaluru(t *testing.T) {
	// A wedding's leftover biryani. Four plausible agents. This is the case the
	// whole project exists to handle, and it is worth one test that reads like
	// the real situation rather than isolated numbers.
	d := donation(domain.CategoryCooked)

	candidates := []domain.Candidate{
		// Closest, but no insulated box and already carrying two jobs.
		agent("bare-busy", at(0.8), load(2), rated(4.0), handles(domain.CategoryCooked)),
		// Slightly farther, properly equipped, idle. Should win.
		agent("equipped-idle", at(1.6), load(0), rated(4.2), insulated(), handles(domain.CategoryCooked)),
		// Equipped and idle but across town.
		agent("equipped-far", at(4.8), load(0), rated(4.8), insulated(), handles(domain.CategoryCooked)),
		// Does not carry cooked food at all - must not appear.
		agent("packaged-only", at(0.3), handles(domain.CategoryPackaged)),
	}

	ranked := RankAgents(d, candidates, 5, nil)

	if len(ranked) != 3 {
		t.Fatalf("expected 3 eligible agents (the packaged-only agent filtered out), got %d", len(ranked))
	}
	if ranked[0].Candidate.AgentID != "equipped-idle" {
		t.Errorf("expected the equipped idle agent to win, got %s (scores: %v)",
			ranked[0].Candidate.AgentID, scoresOf(ranked))
	}
	for _, r := range ranked {
		if r.Candidate.AgentID == "packaged-only" {
			t.Error("an agent who does not handle cooked food was offered cooked food")
		}
	}
}

func TestRealisticScenarioTinnedGoodsPrefersThePlainNearbyAgent(t *testing.T) {
	// The mirror case: for tinned food, the cyclist next door should beat the
	// refrigerated van, who is better saved for the dairy donation.
	d := donation(domain.CategoryPackaged)

	candidates := []domain.Candidate{
		agent("cyclist", at(1.0), handles(domain.CategoryPackaged)),
		agent("fridge-van", at(1.2), refrigerated(), insulated(), handles(domain.CategoryPackaged)),
	}

	ranked := RankAgents(d, candidates, 5, nil)

	if ranked[0].Candidate.AgentID != "cyclist" {
		t.Errorf("expected the plain nearby agent to win tinned goods, got %s (scores: %v)",
			ranked[0].Candidate.AgentID, scoresOf(ranked))
	}
}

func scoresOf(ranked []ScoredAgent) map[string]float64 {
	out := map[string]float64{}
	for _, r := range ranked {
		out[r.Candidate.AgentID] = r.Score
	}
	return out
}

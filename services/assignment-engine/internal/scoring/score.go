// Package scoring is the matching brain: it decides which agent should collect
// which donation, replacing the human admin of the original monolith.
//
// IT IMPORTS NOTHING BUT THE STANDARD LIBRARY AND internal/domain. No Redis, no
// Kafka, no HTTP, no clock. That is deliberate and is the single most useful
// structural decision in this service: "is the algorithm right?" can be
// answered by a unit test with fabricated numbers, entirely separately from
// "is the plumbing right?". Debugging both at once inside a live event pipeline
// is dramatically harder than debugging either alone.
package scoring

import (
	"math"
	"sort"

	"hungerheal/assignment-engine/internal/domain"
)

// Weights for the four scoring terms, exactly as specified in docs/PLAN.md.
// They sum to 0.95 rather than 1.0 - see MaxPossibleScore below. Every score is
// scaled by that same constant, so comparisons between candidates and between
// donations are unaffected.
//
// These are HAND-PICKED DEFAULTS WITH STATED REASONING, not values learned from
// data - there is no historical accept/reject data yet to learn from. A v2 with
// real usage could fit them with logistic regression or a learning-to-rank
// model against "did this agent accept, and how fast did they collect?".
const (
	// Distance is the largest factor because it is the one that most directly
	// determines whether food arrives while it is still worth eating.
	WeightDistance = 0.35

	// Transport suitability. Second-largest: a close agent who cannot keep the
	// food at temperature delivers something nobody can serve.
	WeightCategory = 0.25

	// Current workload. Exists to stop every donation stacking onto the single
	// "best" agent while others sit idle - the same reason a ride-hailing app
	// does not hand you five rides before you finish the first.
	WeightLoad = 0.20

	// Historical reliability. Smallest weight: it is the least direct evidence
	// about THIS pickup, and over-weighting it would entrench early winners and
	// starve newer agents of the work they need to build a record.
	WeightRating = 0.15
)

// MaxPossibleScore is what a theoretically perfect agent scores: standing at
// the pickup point, ideally equipped, idle, rated 5.0.
//
// It is 0.95, not 1.0, because the plan's four weights sum to 0.95
// (0.35 + 0.25 + 0.20 + 0.15). Those values are specified in docs/PLAN.md and
// kept exactly as written rather than quietly rescaled to sum to 1.
//
// It changes nothing about the RANKING: every score is scaled by the same
// constant, so the ordering of candidates is identical either way. It matters
// only when a score is shown to a human, which is why Breakdown also carries
// ScorePercent - "0.75" invites the question "out of what?", and the honest
// answer is 0.95.
const MaxPossibleScore = WeightDistance + WeightCategory + WeightLoad + WeightRating

const (
	// The rating scale agents are stored on.
	MaxRating = 5.0

	// A new agent with no history is seeded here rather than at 0, so they are
	// not locked out of the assignments they need in order to earn a rating.
	NeutralRating = 3.5
)

// Breakdown records every intermediate value behind a score.
//
// This is not debug scaffolding - it is a product requirement. The monitoring
// view in Phase 10 shows WHY the algorithm chose an agent, and "the system
// decided" is not an acceptable answer when a donation goes to the wrong
// person. Everything needed to reconstruct the arithmetic is carried here.
type Breakdown struct {
	DistanceKm       float64 `json:"distanceKm"`
	SearchRadiusKm   float64 `json:"searchRadiusKm"`
	DistanceScore    float64 `json:"distanceScore"`
	CategoryScore    float64 `json:"categoryScore"`
	LoadScore        float64 `json:"loadScore"`
	RatingScore      float64 `json:"ratingScore"`
	CurrentLoad      int     `json:"currentLoad"`
	Rating           float64 `json:"rating"`
	WeightedDistance float64 `json:"weightedDistance"`
	WeightedCategory float64 `json:"weightedCategory"`
	WeightedLoad     float64 `json:"weightedLoad"`
	WeightedRating   float64 `json:"weightedRating"`
	Total            float64 `json:"total"`
	// Total expressed against the maximum actually achievable (0.95), so a
	// human reading the monitoring view is not left guessing the scale.
	ScorePercent float64 `json:"scorePercent"`
}

// ScoredAgent is a candidate with its score and the reasoning behind it.
type ScoredAgent struct {
	Candidate domain.Candidate `json:"candidate"`
	Score     float64          `json:"score"`
	Breakdown Breakdown        `json:"breakdown"`
}

// ---------------------------------------------------------------------------
// The four normalised terms.
//
// Every term is mapped onto 0..1 BEFORE its weight is applied. This is the
// rule that makes the weights mean anything: distance is in kilometres, load is
// a count, rating is out of five. Combining them raw would let whichever
// happened to have the largest numeric range dominate, regardless of the weight
// written next to it.
// ---------------------------------------------------------------------------

// DistanceScore maps distance to 0..1, with 1 meaning "right here".
//
// A note on the spec: docs/PLAN.md writes this term as 1/normalized_distance.
// Taken literally that is unbounded - an agent standing at the pickup point
// scores infinity and no other term can ever matter again - and it contradicts
// the same document's instruction to normalise every term onto 0..1. The linear
// falloff below is what that instruction actually asks for: it keeps the term
// bounded, keeps closer strictly better, and keeps the 0.35 weight meaning 35%.
func DistanceScore(distanceKm, searchRadiusKm float64) float64 {
	if searchRadiusKm <= 0 {
		return 0
	}
	if distanceKm <= 0 {
		return 1
	}
	return clamp01(1 - distanceKm/searchRadiusKm)
}

// LoadScore is 1/(1+load): 0 pending pickups scores 1.0, one scores 0.5, three
// scores 0.25.
//
// The curve is steep at the start on purpose. The difference between an idle
// agent and one already carrying a delivery is large and worth acting on; the
// difference between four jobs and five is not, and by then they should be
// losing to someone free anyway.
func LoadScore(currentLoad int) float64 {
	if currentLoad < 0 {
		currentLoad = 0
	}
	return 1 / (1 + float64(currentLoad))
}

// RatingScore maps a 0..5 rating onto 0..1. A rating of 0 - which only happens
// through data corruption, since new agents start at 3.5 - is treated as
// neutral rather than catastrophic.
func RatingScore(rating float64) float64 {
	if rating <= 0 {
		rating = NeutralRating
	}
	return clamp01(rating / MaxRating)
}

// ScoreAgent is THE function. Pure: same inputs, same output, no I/O, no clock,
// no randomness.
func ScoreAgent(donation domain.Donation, candidate domain.Candidate, searchRadiusKm float64) ScoredAgent {
	distanceScore := DistanceScore(candidate.DistanceKm, searchRadiusKm)
	categoryScore := CategoryCompatibility(donation.Category, candidate.Capabilities)
	loadScore := LoadScore(candidate.CurrentLoad)
	ratingScore := RatingScore(candidate.Rating)

	b := Breakdown{
		DistanceKm:       candidate.DistanceKm,
		SearchRadiusKm:   searchRadiusKm,
		DistanceScore:    round4(distanceScore),
		CategoryScore:    round4(categoryScore),
		LoadScore:        round4(loadScore),
		RatingScore:      round4(ratingScore),
		CurrentLoad:      candidate.CurrentLoad,
		Rating:           candidate.Rating,
		WeightedDistance: round4(distanceScore * WeightDistance),
		WeightedCategory: round4(categoryScore * WeightCategory),
		WeightedLoad:     round4(loadScore * WeightLoad),
		WeightedRating:   round4(ratingScore * WeightRating),
	}

	b.Total = round4(b.WeightedDistance + b.WeightedCategory + b.WeightedLoad + b.WeightedRating)
	b.ScorePercent = round4(b.Total / MaxPossibleScore * 100)

	return ScoredAgent{Candidate: candidate, Score: b.Total, Breakdown: b}
}

// RankAgents scores every eligible candidate and returns them best-first.
//
// `excluded` holds agents who already declined or let this donation time out.
// They are dropped rather than re-offered, so a re-score after a timeout does
// not hand the donation straight back to whoever just ignored it.
func RankAgents(
	donation domain.Donation,
	candidates []domain.Candidate,
	searchRadiusKm float64,
	excluded map[string]bool,
) []ScoredAgent {
	ranked := make([]ScoredAgent, 0, len(candidates))

	for _, c := range candidates {
		// ---- hard filters, applied before any scoring ----

		if excluded[c.AgentID] {
			continue
		}
		// Marked as not accepting work.
		if !c.Available {
			continue
		}
		// Does not carry this category at all. A score penalty would be wrong
		// here: it would still let them win when they are the only candidate,
		// which is exactly the case where it matters most that they cannot.
		if !c.Capabilities.Handles(donation.Category) {
			continue
		}

		ranked = append(ranked, ScoreAgent(donation, c, searchRadiusKm))
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		// Deterministic tie-break, so an identical situation always produces an
		// identical decision. Nearer first, then by id purely so the order can
		// never depend on map iteration or Redis reply ordering - a flaky
		// ranking is nearly impossible to debug from logs.
		if ranked[i].Candidate.DistanceKm != ranked[j].Candidate.DistanceKm {
			return ranked[i].Candidate.DistanceKm < ranked[j].Candidate.DistanceKm
		}
		return ranked[i].Candidate.AgentID < ranked[j].Candidate.AgentID
	})

	return ranked
}

// TopN takes the best n, which is how the parallel-offer batch is chosen.
func TopN(ranked []ScoredAgent, n int) []ScoredAgent {
	if n <= 0 || len(ranked) == 0 {
		return []ScoredAgent{}
	}
	if len(ranked) < n {
		n = len(ranked)
	}
	return ranked[:n]
}

// ----------------------------------------------------------------- helpers

func clamp01(v float64) float64 {
	if math.IsNaN(v) {
		return 0
	}
	return math.Max(0, math.Min(1, v))
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}

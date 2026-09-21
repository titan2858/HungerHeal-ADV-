package scoring

import (
	"time"

	"hungerheal/assignment-engine/internal/domain"
)

// ---------------------------------------------------------------------------
// URGENCY IS NOT A SCORING TERM.
//
// It would be easy to add it as a fifth weighted term, and it would be wrong.
// Urgency says nothing about which agent is best suited - a cooked meal being
// urgent does not make a distant agent with no insulated box a better choice.
// Adding it as a score term would let a high-urgency donation outrank a much
// closer agent, which is backwards.
//
// What urgency actually changes is TIME: how long an agent has to respond
// before the offer moves on, and how aggressively the search widens when nobody
// is found. Both are properties of the situation, not of the candidate.
// ---------------------------------------------------------------------------

type Urgency string

const (
	UrgencyHigh   Urgency = "HIGH"
	UrgencyMedium Urgency = "MEDIUM"
	UrgencyLow    Urgency = "LOW"
)

// UrgencyOf maps a food category to how fast it must move.
func UrgencyOf(category string) Urgency {
	switch category {
	case domain.CategoryCooked, domain.CategoryPerishRaw:
		// Hot meals and dairy: unsafe or unappetising within hours.
		return UrgencyHigh
	case domain.CategoryBakery, domain.CategoryBeverages:
		return UrgencyMedium
	case domain.CategoryPackaged:
		// Tins and grains keep for months. There is time to find a good match.
		return UrgencyLow
	default:
		// An unknown category is treated as urgent. If the guess is wrong the
		// cost is a slightly hurried reassignment; the opposite mistake is
		// letting food spoil while the system waits patiently.
		return UrgencyHigh
	}
}

// ResponseTimeout is how long an offered agent has to accept before the
// donation is re-scored and offered to the next batch (Phase 6 acts on this).
func ResponseTimeout(category string) time.Duration {
	switch UrgencyOf(category) {
	case UrgencyHigh:
		// 90s. Short enough that a cooling meal is not stuck waiting on someone
		// who has put their phone down; long enough to glance at a notification
		// and decide.
		return 90 * time.Second
	case UrgencyMedium:
		return 3 * time.Minute
	default:
		return 5 * time.Minute
	}
}

// RadiusLadderKm is the sequence of search radii to try when the previous one
// found nobody.
//
// The ladders differ by urgency in shape, not just size:
//
//   - HIGH jumps far, fast. For a cooling meal, an agent 25km away who says yes
//     now beats a perfect match found after four rounds of patient searching.
//   - LOW widens gently. Packaged goods keep, so it is worth several careful
//     rounds to find a genuinely well-suited nearby agent instead of sending
//     someone across the city for tinned beans.
//
// All start at 5km, the plan's opening radius.
func RadiusLadderKm(category string) []float64 {
	switch UrgencyOf(category) {
	case UrgencyHigh:
		return []float64{5, 12, 25, 50}
	case UrgencyMedium:
		return []float64{5, 10, 20, 35}
	default:
		return []float64{5, 8, 12, 20}
	}
}

// MaxRadiusKm is the last rung of the ladder - beyond it, the donation is
// published as unassigned and queued for retry rather than offered to someone
// implausibly far away.
func MaxRadiusKm(category string) float64 {
	ladder := RadiusLadderKm(category)
	return ladder[len(ladder)-1]
}

package scoring

import "hungerheal/assignment-engine/internal/domain"

// ---------------------------------------------------------------------------
// The category/transport compatibility matrix.
//
// This is the 0.25-weight term, and it is deliberately a 0-1 SCALE rather than
// a binary pass/fail. If a transport mismatch scored zero, a donation in an
// area where nobody has an insulated box would score every candidate at zero
// and the ranking would collapse to noise - the engine would effectively pick
// at random among people it had declared all equally unsuitable.
//
// Rows are what the agent can carry; columns are what the food needs.
// ---------------------------------------------------------------------------

// TransportTier collapses the two capability flags into the four cases that
// actually differ.
type TransportTier int

const (
	TierNone TransportTier = iota
	TierInsulated
	TierRefrigerated
	TierBoth
)

func tierOf(c domain.Capabilities) TransportTier {
	switch {
	case c.HasInsulatedTransport && c.HasRefrigeration:
		return TierBoth
	case c.HasRefrigeration:
		return TierRefrigerated
	case c.HasInsulatedTransport:
		return TierInsulated
	default:
		return TierNone
	}
}

// compatibilityMatrix[tier][category] -> 0..1
//
// Two principles are encoded here, and the second is easy to miss:
//
//  1. CAPABILITY. Cooked food needs to stay hot, so insulated transport scores
//     1.0 and bare transport scores low. Raw perishables want cooling, so
//     refrigeration scores highest there.
//
//  2. SPECIALISATION. An agent WITH an insulated box scores LOWER on dry
//     packaged goods than an agent without one. That looks backwards until you
//     consider the alternative: if specialised agents always outranked plain
//     ones, every donation would flow to them, and the one cooked meal that
//     genuinely needs an insulated box would find them all busy carrying
//     canned beans. Scoring them down on food that does not need them keeps
//     them free for food that does.
//
// Nothing here is zero. The floor is 0.35, which is low enough to lose any
// contest against a properly equipped agent nearby, but high enough that a
// poorly matched agent still beats nobody at all - a rule that matters most in
// exactly the sparse areas where matching is hardest.
var compatibilityMatrix = map[TransportTier]map[string]float64{
	TierBoth: {
		domain.CategoryCooked:    1.00, // insulated: ideal
		domain.CategoryPerishRaw: 1.00, // refrigerated: ideal
		domain.CategoryBakery:    0.70, // capable, but save them for food that needs it
		domain.CategoryPackaged:  0.55, // the most over-qualified pairing there is
		domain.CategoryBeverages: 0.70,
	},
	TierRefrigerated: {
		domain.CategoryCooked:    0.80, // cold storage keeps it safe, not hot
		domain.CategoryPerishRaw: 1.00,
		domain.CategoryBakery:    0.75,
		domain.CategoryPackaged:  0.60,
		domain.CategoryBeverages: 0.75,
	},
	TierInsulated: {
		domain.CategoryCooked:    1.00,
		domain.CategoryPerishRaw: 0.75, // insulation slows warming; it is not cooling
		domain.CategoryBakery:    0.75,
		domain.CategoryPackaged:  0.60,
		domain.CategoryBeverages: 0.75,
	},
	TierNone: {
		domain.CategoryCooked:    0.40, // it will arrive lukewarm, but it will arrive
		domain.CategoryPerishRaw: 0.45,
		domain.CategoryBakery:    1.00, // bread needs nothing special: a perfect match
		domain.CategoryPackaged:  1.00,
		domain.CategoryBeverages: 0.95,
	},
}

// CategoryCompatibility scores how well this agent's transport suits this food,
// on 0..1.
func CategoryCompatibility(category string, caps domain.Capabilities) float64 {
	row, ok := compatibilityMatrix[tierOf(caps)]
	if !ok {
		return defaultCompatibility
	}

	score, ok := row[category]
	if !ok {
		// An unknown category should not silently score 0 and drag every
		// candidate down equally; a neutral value keeps the other three terms
		// doing useful work while the unknown category gets noticed elsewhere.
		return defaultCompatibility
	}
	return score
}

const defaultCompatibility = 0.5

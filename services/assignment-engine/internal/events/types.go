package events

import (
	"time"

	"hungerheal/assignment-engine/internal/scoring"
)

// Topics this service reads and writes.
const (
	TopicDonationCreated    = "donation.created"
	TopicDonationAssigned   = "donation.assigned"
	TopicDonationUnassigned = "donation.unassigned"
	TopicDonationTimeout    = "donation.timeout"
)

// DonationCreated is the event donation-service publishes. Field names match
// its producer exactly - this struct IS the contract between the two services.
type DonationCreated struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string `json:"donationId"`
	DonorID    string `json:"donorId"`
	Category   string `json:"category"`

	Quantity struct {
		Amount float64 `json:"amount"`
		Unit   string  `json:"unit"`
	} `json:"quantity"`

	BestBefore time.Time `json:"bestBefore"`

	Pickup struct {
		Address string `json:"address"`
		// Pointers, because donation-service sends explicit nulls for a
		// donation whose address has not been geocoded. A plain float64 would
		// turn "not geocoded" into "the Atlantic Ocean at 0,0".
		Lat *float64 `json:"lat"`
		Lng *float64 `json:"lng"`
	} `json:"pickup"`
}

// Offer is one agent being asked to collect, with the reasoning that selected
// them. The breakdown travels with the offer so the monitoring view in Phase 10
// can show WHY without recomputing anything.
type Offer struct {
	AgentID   string            `json:"agentId"`
	AgentName string            `json:"agentName"`
	Phone     string            `json:"phone"`
	Rank      int               `json:"rank"`
	Score     float64           `json:"score"`
	Breakdown scoring.Breakdown `json:"breakdown"`
}

// DonationAssigned announces that a donation has been offered to a batch of
// agents in parallel.
//
// The name is inherited from the plan's topic list. Note what it does NOT mean:
// nobody has accepted yet. The donation belongs to whichever of these agents
// accepts first (Phase 6 arbitrates that race with a Redis lock).
type DonationAssigned struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string `json:"donationId"`
	DonorID    string `json:"donorId"`
	Category   string `json:"category"`

	Pickup struct {
		Address string  `json:"address"`
		Lat     float64 `json:"lat"`
		Lng     float64 `json:"lng"`
	} `json:"pickup"`

	// Every agent offered this donation, best-scoring first.
	Offers []Offer `json:"offers"`

	// How the search went, so a human can tell "the best agent in the city" from
	// "the only agent we could find after widening four times".
	SearchRadiusKm     float64 `json:"searchRadiusKm"`
	RadiusAttempts     int     `json:"radiusAttempts"`
	CandidatesFound    int     `json:"candidatesFound"`
	CandidatesEligible int     `json:"candidatesEligible"`

	// Set by urgency, not by score. tracking-service starts a timer of this
	// length in Phase 7.
	ResponseTimeoutSeconds int    `json:"responseTimeoutSeconds"`
	Urgency                string `json:"urgency"`
}

// UnassignedReason explains why no offer could be made. A machine-readable code
// rather than prose, because the donor-facing message and the retry policy both
// branch on it.
type UnassignedReason string

const (
	// The address never resolved to coordinates, so no radius search is
	// possible. Retrying will not help until it is geocoded.
	ReasonNotGeocoded UnassignedReason = "NOT_GEOCODED"

	// Nobody was online and eligible within the widest radius. Worth retrying:
	// agents come online continuously.
	ReasonNoAgentsFound UnassignedReason = "NO_AGENTS_FOUND"

	// Agents were nearby but none of them carry this category.
	ReasonNoEligibleAgents UnassignedReason = "NO_ELIGIBLE_AGENTS"

	// Every eligible agent has already declined or timed out on this donation.
	ReasonAllAgentsExhausted UnassignedReason = "ALL_AGENTS_EXHAUSTED"
)

// DonationUnassigned says the donation could not be placed right now.
//
// It is published rather than silently dropped because the plan is explicit:
// "don't let it silently disappear". The donor is told it is still pending, and
// the donation is queued for retry.
type DonationUnassigned struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string           `json:"donationId"`
	DonorID    string           `json:"donorId"`
	Category   string           `json:"category"`
	Reason     UnassignedReason `json:"reason"`
	Message    string           `json:"message"`

	SearchedRadiusKm float64 `json:"searchedRadiusKm"`
	CandidatesFound  int     `json:"candidatesFound"`
	Retryable        bool    `json:"retryable"`
}

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
	TopicDonationAccepted   = "donation.accepted"
	TopicDonationRejected   = "donation.rejected"
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

	// Set by urgency, not by score. The engine arms a deadline of this length
	// when it publishes the offer.
	ResponseTimeoutSeconds int    `json:"responseTimeoutSeconds"`
	Urgency                string `json:"urgency"`

	// Which offer round this is. 1 is the first batch; it increments each time
	// a timeout forces a re-score, so a consumer can tell a fresh offer from
	// the fourth attempt to place a donation nobody wants.
	Round int `json:"round"`
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
	// How many offer rounds were attempted before giving up.
	Round     int  `json:"round"`
	Retryable bool `json:"retryable"`
}

// DonationTimeout says an offer batch expired without anyone accepting.
//
// The engine both publishes and consumes this. That looks odd at first, but it
// is the right shape: going through the log rather than calling a function
// directly means the re-score is durable (it survives a restart mid-timeout),
// idempotent by the same dedup path as every other event, and visible in Kafka
// UI alongside the rest of the donation's history.
type DonationTimeout struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string `json:"donationId"`
	DonorID    string `json:"donorId"`
	Category   string `json:"category"`

	// Which round of offers expired, and who ignored it.
	Round     int      `json:"round"`
	OfferedTo []string `json:"offeredTo"`
	// The radius that produced the expired batch. The next round starts from
	// here rather than beginning again at 5km.
	RadiusKm float64 `json:"radiusKm"`
}

// DonationAccepted is published when an agent wins the claim race.
//
// tracking-service consumes it in Phase 7 to move the donation to ACCEPTED, and
// notification-service to tell the donor who is coming.
type DonationAccepted struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string `json:"donationId"`
	DonorID    string `json:"donorId"`
	Category   string `json:"category"`

	AgentID    string `json:"agentId"`
	AgentName  string `json:"agentName"`
	AgentPhone string `json:"agentPhone"`

	// The agent's load AFTER accepting, so a consumer does not have to read
	// Redis to know it.
	AgentLoad int64 `json:"agentLoad"`

	// How long it took from the offer going out to someone saying yes. The
	// headline number for Phase 11's analytics.
	ResponseSeconds float64 `json:"responseSeconds"`
	Round           int     `json:"round"`
}

// DonationRejected is published when an offered agent declines.
//
// A rejection is NOT a failure - it is useful information. It removes that
// agent from the exclusion set for this donation and, once everyone in the
// batch has answered, lets the engine re-score immediately instead of waiting
// out a deadline nobody is going to meet.
type DonationRejected struct {
	EventID      string    `json:"eventId"`
	EventType    string    `json:"eventType"`
	EventVersion int       `json:"eventVersion"`
	OccurredAt   time.Time `json:"occurredAt"`
	TraceID      string    `json:"traceId"`

	DonationID string `json:"donationId"`
	DonorID    string `json:"donorId"`
	AgentID    string `json:"agentId"`
	Reason     string `json:"reason"`

	// Whether anyone in the current batch has still not answered.
	RemainingInBatch int `json:"remainingInBatch"`
}

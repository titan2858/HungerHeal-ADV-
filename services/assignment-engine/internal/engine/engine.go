// Package engine orchestrates a donation's whole journey: scoring, offering,
// waiting, re-offering, and finally either an agent accepting or the donor
// being told nobody could be found.
//
// It depends on INTERFACES, not on Redis and Kafka directly, so the entire
// decision flow can be unit-tested with fakes and no infrastructure at all.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"hungerheal/assignment-engine/internal/domain"
	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/logging"
	"hungerheal/assignment-engine/internal/offers"
	"hungerheal/assignment-engine/internal/scoring"
)

// CandidateSource finds agents near a point.
type CandidateSource interface {
	FindWithin(ctx context.Context, lat, lng, radiusKm float64, limit int) ([]domain.Candidate, error)
}

// Publisher emits events.
type Publisher interface {
	Publish(ctx context.Context, topic, key string, payload any, traceID, eventID string) error
}

// OfferStore holds live offer state: deadlines, declines, and the claim lock.
type OfferStore interface {
	SaveState(ctx context.Context, st offers.State, ttl time.Duration) error
	GetState(ctx context.Context, donationID string) (*offers.State, error)
	Claim(ctx context.Context, donationID, agentID string, ttl time.Duration) error
	ClaimedBy(ctx context.Context, donationID string) (string, error)
	Decline(ctx context.Context, donationID string, agentIDs ...string) error
	Declined(ctx context.Context, donationID string) (map[string]bool, error)
	PendingResponses(ctx context.Context, donationID string, offeredTo []string) (int, error)
	ClearDeadline(ctx context.Context, donationID string) error
	IncrementAgentLoad(ctx context.Context, agentID string) (int64, error)
}

type Engine struct {
	Candidates     CandidateSource
	Publisher      Publisher
	Offers         OfferStore
	Logger         *slog.Logger
	OfferBatchSize int
	MaxCandidates  int

	// MaxRounds caps how many times one donation is re-offered.
	//
	// Without it the timeout loop can run forever: every round excludes the
	// agents who just ignored the offer, but a city with a hundred agents would
	// happily work through all of them one batch at a time while the food goes
	// cold. At some point "nobody is taking this" is the honest answer, and the
	// donor is better served by being told than by a spinner.
	MaxRounds int

	// How long offer state is kept after the deadline, so a late accept gets a
	// meaningful answer instead of a bare 404.
	StateTTL time.Duration
}

// Result records what happened, for logging and for tests to assert on.
type Result struct {
	Assigned        bool
	Offers          []events.Offer
	Reason          events.UnassignedReason
	RadiusUsedKm    float64
	RadiusAttempts  int
	CandidatesFound int
	Eligible        int
	Round           int
}

// ---------------------------------------------------------------------------
// donation.created
// ---------------------------------------------------------------------------

// Handle processes a newly created donation: round 1 of offers.
func (e *Engine) Handle(ctx context.Context, evt events.DonationCreated) (Result, error) {
	log := logging.FromContext(ctx, e.Logger).With(
		"donationId", evt.DonationID, "category", evt.Category)

	// A donation whose address never resolved has no point to search around.
	// Published rather than dropped, so it does not silently disappear.
	if evt.Pickup.Lat == nil || evt.Pickup.Lng == nil {
		log.Warn("donation has no coordinates; cannot be matched")
		res := Result{Reason: events.ReasonNotGeocoded}
		return res, e.publishUnassigned(ctx, unassignedInput{
			donationID: evt.DonationID, donorID: evt.DonorID,
			category: evt.Category, traceID: evt.TraceID,
		}, res, "the pickup address has not been geocoded, so no agents can be searched for")
	}

	donation := domain.Donation{
		DonationID: evt.DonationID,
		DonorID:    evt.DonorID,
		Category:   evt.Category,
		Lat:        *evt.Pickup.Lat,
		Lng:        *evt.Pickup.Lng,
		BestBefore: evt.BestBefore,
		TraceID:    evt.TraceID,
	}

	return e.offerRound(ctx, log, offerRoundInput{
		donation:   donation,
		address:    evt.Pickup.Address,
		round:      1,
		fromRadius: 0, // start at the bottom of the ladder
		excluded:   nil,
	})
}

// ---------------------------------------------------------------------------
// donation.timeout
// ---------------------------------------------------------------------------

// HandleTimeout re-scores a donation whose offer batch expired.
//
// This is what closes the loop. Everyone in the expired batch is added to the
// exclusion set first - without that the re-score finds the identical top 3
// (nothing about them has changed) and offers it straight back to the agents
// who just ignored it, and the donation bounces between the same people until
// it expires.
func (e *Engine) HandleTimeout(ctx context.Context, evt events.DonationTimeout) (Result, error) {
	// Bound as timedOutRound, not round: offerRound logs the NEW round on the
	// same logger, and two attributes called "round" in one JSON line is a
	// duplicate key - which log processors are free to drop or reorder, making
	// the line say something other than what happened.
	log := logging.FromContext(ctx, e.Logger).With(
		"donationId", evt.DonationID, "timedOutRound", evt.Round)

	// Someone may have accepted in the gap between the deadline firing and this
	// event being processed. Re-offering then would send a second agent to a
	// donation already being collected.
	if claimed, err := e.Offers.ClaimedBy(ctx, evt.DonationID); err != nil {
		return Result{}, fmt.Errorf("could not check the claim: %w", err)
	} else if claimed != "" {
		log.Info("timeout ignored - the donation was accepted in the meantime",
			"agentId", claimed)
		return Result{Assigned: true}, nil
	}

	// Everyone who let this round lapse is out of the running for this donation.
	if err := e.Offers.Decline(ctx, evt.DonationID, evt.OfferedTo...); err != nil {
		return Result{}, fmt.Errorf("could not record the lapsed offers: %w", err)
	}

	state, err := e.Offers.GetState(ctx, evt.DonationID)
	if err != nil {
		return Result{}, fmt.Errorf("could not read offer state: %w", err)
	}
	if state == nil {
		// The state expired, so there is nothing left to re-score against. Very
		// old donations legitimately reach this.
		log.Warn("offer state has expired; not re-offering")
		return Result{}, nil
	}

	nextRound := evt.Round + 1
	if nextRound > e.MaxRounds {
		log.Warn("giving up after the maximum number of offer rounds",
			"maxRounds", e.MaxRounds)

		declined, _ := e.Offers.Declined(ctx, evt.DonationID)
		res := Result{
			Reason:       events.ReasonAllAgentsExhausted,
			RadiusUsedKm: state.RadiusKm,
			Round:        evt.Round,
		}
		return res, e.publishUnassigned(ctx, unassignedInput{
			donationID: evt.DonationID, donorID: state.DonorID,
			category: state.Category, traceID: state.TraceID,
		}, res, fmt.Sprintf("%d agents were offered this donation across %d rounds and none accepted",
			len(declined), evt.Round))
	}

	excluded, err := e.Offers.Declined(ctx, evt.DonationID)
	if err != nil {
		return Result{}, fmt.Errorf("could not read the exclusion set: %w", err)
	}

	donation := domain.Donation{
		DonationID: evt.DonationID,
		DonorID:    state.DonorID,
		Category:   state.Category,
		Lat:        state.Lat,
		Lng:        state.Lng,
		TraceID:    state.TraceID,
	}

	log.Info("re-scoring after timeout",
		"excludedAgents", len(excluded), "nextRound", nextRound, "fromRadiusKm", state.RadiusKm)

	return e.offerRound(ctx, log, offerRoundInput{
		donation: donation,
		address:  state.Address,
		round:    nextRound,
		// Resume from the radius that produced the last batch rather than
		// starting again at 5km: those nearby agents are already excluded, so
		// re-searching the same small circle would just find nobody.
		fromRadius: state.RadiusKm,
		excluded:   excluded,
	})
}

// ---------------------------------------------------------------------------
// the shared offer path
// ---------------------------------------------------------------------------

type offerRoundInput struct {
	donation   domain.Donation
	address    string
	round      int
	fromRadius float64
	excluded   map[string]bool
}

func (e *Engine) offerRound(ctx context.Context, log *slog.Logger, in offerRoundInput) (Result, error) {
	ladder := scoring.RadiusLadderKm(in.donation.Category)
	urgency := scoring.UrgencyOf(in.donation.Category)

	var (
		ranked       []scoring.ScoredAgent
		usedRadius   float64
		attempts     int
		foundAtAll   int
		lastEligible int
	)

	for _, radiusKm := range ladder {
		// On a re-score, skip rungs already searched - every agent found there
		// is in the exclusion set by now.
		if radiusKm < in.fromRadius {
			continue
		}

		attempts++
		usedRadius = radiusKm

		found, err := e.Candidates.FindWithin(ctx, in.donation.Lat, in.donation.Lng, radiusKm, e.MaxCandidates)
		if err != nil {
			// A lookup failure is NOT "no agents found". Saying so would
			// publish a wrong answer and mark the donation handled, losing a
			// donation that was perfectly placeable.
			return Result{}, fmt.Errorf("candidate lookup failed at %.0fkm: %w", radiusKm, err)
		}

		if len(found) > foundAtAll {
			foundAtAll = len(found)
		}

		ranked = scoring.RankAgents(in.donation, found, radiusKm, in.excluded)
		lastEligible = len(ranked)

		log.Debug("radius attempt",
			"radiusKm", radiusKm, "found", len(found), "eligible", len(ranked))

		if len(ranked) > 0 {
			break
		}
	}

	if len(ranked) == 0 {
		reason := events.ReasonNoAgentsFound
		message := fmt.Sprintf("no agents online within %.0fkm", usedRadius)

		switch {
		case len(in.excluded) > 0:
			// Distinct from "nobody is here": everyone who IS here has already
			// turned this donation down, and waiting will not change that.
			reason = events.ReasonAllAgentsExhausted
			message = fmt.Sprintf("every eligible agent within %.0fkm has already declined or not responded", usedRadius)
		case foundAtAll > 0:
			reason = events.ReasonNoEligibleAgents
			message = fmt.Sprintf("%d agents nearby, but none available for %s", foundAtAll, in.donation.Category)
		}

		log.Warn("no agent could be matched",
			"reason", reason, "radiusKm", usedRadius, "candidatesFound", foundAtAll)

		res := Result{
			Reason:          reason,
			RadiusUsedKm:    usedRadius,
			RadiusAttempts:  attempts,
			CandidatesFound: foundAtAll,
			Round:           in.round,
		}
		return res, e.publishUnassigned(ctx, unassignedInput{
			donationID: in.donation.DonationID, donorID: in.donation.DonorID,
			category: in.donation.Category, traceID: in.donation.TraceID,
		}, res, message)
	}

	top := scoring.TopN(ranked, e.OfferBatchSize)

	offerList := make([]events.Offer, 0, len(top))
	offeredTo := make([]string, 0, len(top))
	for i, s := range top {
		offerList = append(offerList, events.Offer{
			AgentID:   s.Candidate.AgentID,
			AgentName: s.Candidate.Name,
			Phone:     s.Candidate.Phone,
			Rank:      i + 1,
			Score:     s.Score,
			Breakdown: s.Breakdown,
		})
		offeredTo = append(offeredTo, s.Candidate.AgentID)
	}

	timeout := scoring.ResponseTimeout(in.donation.Category)
	expiresAt := time.Now().UTC().Add(timeout)

	// STATE BEFORE EVENT, deliberately. If the event went out first and the
	// process died before the deadline was armed, three agents would hold an
	// offer that nothing was ever going to expire - the donation would stall
	// with no timer and no error. Saving first means the worst case is an armed
	// deadline for an offer nobody received, which the next timeout resolves.
	if err := e.Offers.SaveState(ctx, offers.State{
		DonationID: in.donation.DonationID,
		DonorID:    in.donation.DonorID,
		Category:   in.donation.Category,
		Address:    in.address,
		Lat:        in.donation.Lat,
		Lng:        in.donation.Lng,
		TraceID:    in.donation.TraceID,
		Round:      in.round,
		RadiusKm:   usedRadius,
		OfferedTo:  offeredTo,
		ExpiresAt:  expiresAt,
	}, e.StateTTL); err != nil {
		return Result{}, fmt.Errorf("could not save offer state: %w", err)
	}

	assigned := events.DonationAssigned{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationAssigned,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      in.donation.TraceID,

		DonationID: in.donation.DonationID,
		DonorID:    in.donation.DonorID,
		Category:   in.donation.Category,

		Offers:             offerList,
		SearchRadiusKm:     usedRadius,
		RadiusAttempts:     attempts,
		CandidatesFound:    foundAtAll,
		CandidatesEligible: lastEligible,

		ResponseTimeoutSeconds: int(timeout.Seconds()),
		Urgency:                string(urgency),
		Round:                  in.round,
	}
	assigned.Pickup.Address = in.address
	assigned.Pickup.Lat = in.donation.Lat
	assigned.Pickup.Lng = in.donation.Lng

	log.Info("donation offered to agents",
		"offers", len(offerList), "round", in.round,
		"topAgent", offerList[0].AgentID, "topScore", offerList[0].Score,
		"radiusKm", usedRadius, "eligible", lastEligible,
		"timeoutSeconds", assigned.ResponseTimeoutSeconds)

	if err := e.Publisher.Publish(ctx, events.TopicDonationAssigned, in.donation.DonationID,
		assigned, in.donation.TraceID, assigned.EventID); err != nil {
		return Result{}, fmt.Errorf("could not publish donation.assigned: %w", err)
	}

	return Result{
		Assigned:        true,
		Offers:          offerList,
		RadiusUsedKm:    usedRadius,
		RadiusAttempts:  attempts,
		CandidatesFound: foundAtAll,
		Eligible:        lastEligible,
		Round:           in.round,
	}, nil
}

// ---------------------------------------------------------------------------
// agent responses
// ---------------------------------------------------------------------------

// AcceptResult is what the accepting agent is told.
type AcceptResult struct {
	DonationID      string  `json:"donationId"`
	AgentID         string  `json:"agentId"`
	AgentLoad       int64   `json:"agentLoad"`
	ResponseSeconds float64 `json:"responseSeconds"`
	Address         string  `json:"address"`
	Lat             float64 `json:"lat"`
	Lng             float64 `json:"lng"`
}

// ErrNotOffered is returned when an agent responds to a donation that was never
// offered to them. Not merely tidiness: without the check, any agent could
// claim any donation id they could guess.
var ErrNotOffered = errors.New("this donation was not offered to you")

// ErrOfferExpired is returned when the batch has already moved on.
var ErrOfferExpired = errors.New("this offer is no longer open")

// Accept arbitrates the race between the agents offered a donation in parallel.
func (e *Engine) Accept(ctx context.Context, donationID, agentID, agentName, agentPhone string) (*AcceptResult, error) {
	log := logging.FromContext(ctx, e.Logger).With("donationId", donationID, "agentId", agentID)

	state, err := e.Offers.GetState(ctx, donationID)
	if err != nil {
		return nil, fmt.Errorf("could not read offer state: %w", err)
	}
	if state == nil {
		return nil, ErrOfferExpired
	}
	if !contains(state.OfferedTo, agentID) {
		return nil, ErrNotOffered
	}

	// The race is settled here. Exactly one caller creates the key.
	if err := e.Offers.Claim(ctx, donationID, agentID, e.StateTTL); err != nil {
		if errors.Is(err, offers.ErrAlreadyClaimed) {
			// Not an error condition in the system's eyes - two people were
			// asked at once and one of them was faster. The loser is told
			// plainly so their app can close the notification.
			log.Info("agent lost the claim race")
			return nil, offers.ErrAlreadyClaimed
		}
		return nil, fmt.Errorf("could not claim the donation: %w", err)
	}

	// The load counter has to move before the next donation is scored, or an
	// agent who just accepted still looks idle and immediately wins another.
	load, err := e.Offers.IncrementAgentLoad(ctx, agentID)
	if err != nil {
		// The claim already succeeded and the agent has been told the donation
		// is theirs. Failing the request now would be worse than a briefly
		// stale counter.
		log.Error("could not increment the agent load counter", "err", err.Error())
	}

	responseSeconds := time.Since(state.ExpiresAt.Add(-scoring.ResponseTimeout(state.Category))).Seconds()

	accepted := events.DonationAccepted{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationAccepted,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      state.TraceID,

		DonationID: donationID,
		DonorID:    state.DonorID,
		Category:   state.Category,

		AgentID:    agentID,
		AgentName:  agentName,
		AgentPhone: agentPhone,
		AgentLoad:  load,

		ResponseSeconds: round2(responseSeconds),
		Round:           state.Round,
	}

	if err := e.Publisher.Publish(ctx, events.TopicDonationAccepted, donationID,
		accepted, state.TraceID, accepted.EventID); err != nil {
		// The agent already holds the claim, so this cannot be undone by
		// failing. Logged loudly: tracking-service will not learn about it.
		log.Error("could not publish donation.accepted", "err", err.Error())
	}

	log.Info("donation accepted", "responseSeconds", accepted.ResponseSeconds, "agentLoad", load)

	return &AcceptResult{
		DonationID:      donationID,
		AgentID:         agentID,
		AgentLoad:       load,
		ResponseSeconds: accepted.ResponseSeconds,
		Address:         state.Address,
		Lat:             state.Lat,
		Lng:             state.Lng,
	}, nil
}

// Reject records a decline and, when the whole batch has answered, re-scores
// immediately rather than waiting out a deadline nobody is going to meet.
func (e *Engine) Reject(ctx context.Context, donationID, agentID, reason string) (int, error) {
	log := logging.FromContext(ctx, e.Logger).With("donationId", donationID, "agentId", agentID)

	state, err := e.Offers.GetState(ctx, donationID)
	if err != nil {
		return 0, fmt.Errorf("could not read offer state: %w", err)
	}
	if state == nil {
		return 0, ErrOfferExpired
	}
	if !contains(state.OfferedTo, agentID) {
		return 0, ErrNotOffered
	}

	if err := e.Offers.Decline(ctx, donationID, agentID); err != nil {
		return 0, fmt.Errorf("could not record the decline: %w", err)
	}

	remaining, err := e.Offers.PendingResponses(ctx, donationID, state.OfferedTo)
	if err != nil {
		return 0, fmt.Errorf("could not count pending responses: %w", err)
	}

	rejected := events.DonationRejected{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationRejected,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      state.TraceID,

		DonationID:       donationID,
		DonorID:          state.DonorID,
		AgentID:          agentID,
		Reason:           reason,
		RemainingInBatch: remaining,
	}

	if err := e.Publisher.Publish(ctx, events.TopicDonationRejected, donationID,
		rejected, state.TraceID, rejected.EventID); err != nil {
		log.Error("could not publish donation.rejected", "err", err.Error())
	}

	log.Info("agent declined the donation", "remainingInBatch", remaining)

	// Everyone has now said no. Waiting out the remaining seconds of a deadline
	// would just be time the food spends going cold for no reason.
	if remaining == 0 {
		if claimed, _ := e.Offers.ClaimedBy(ctx, donationID); claimed == "" {
			log.Info("the whole batch declined; re-scoring immediately")

			if err := e.Offers.ClearDeadline(ctx, donationID); err != nil {
				log.Warn("could not clear the deadline", "err", err.Error())
			}

			timeoutEvt := events.DonationTimeout{
				EventID:      uuid.NewString(),
				EventType:    events.TopicDonationTimeout,
				EventVersion: 1,
				OccurredAt:   time.Now().UTC(),
				TraceID:      state.TraceID,

				DonationID: donationID,
				DonorID:    state.DonorID,
				Category:   state.Category,
				Round:      state.Round,
				OfferedTo:  state.OfferedTo,
				RadiusKm:   state.RadiusKm,
			}

			// Published rather than re-scored inline, so the re-offer goes
			// through exactly the same durable, deduplicated path as a real
			// timeout instead of a second code path that could drift from it.
			if err := e.Publisher.Publish(ctx, events.TopicDonationTimeout, donationID,
				timeoutEvt, state.TraceID, timeoutEvt.EventID); err != nil {
				log.Error("could not publish the early re-score", "err", err.Error())
			}
		}
	}

	return remaining, nil
}

// ---------------------------------------------------------------------------

type unassignedInput struct {
	donationID string
	donorID    string
	category   string
	traceID    string
}

func (e *Engine) publishUnassigned(ctx context.Context, in unassignedInput, res Result, message string) error {
	payload := events.DonationUnassigned{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationUnassigned,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      in.traceID,

		DonationID: in.donationID,
		DonorID:    in.donorID,
		Category:   in.category,
		Reason:     res.Reason,
		Message:    message,

		SearchedRadiusKm: res.RadiusUsedKm,
		CandidatesFound:  res.CandidatesFound,
		Round:            res.Round,
		// A missing geocode will not fix itself by waiting; agents coming
		// online will. The retry policy branches on exactly this.
		Retryable: res.Reason != events.ReasonNotGeocoded,
	}

	return e.Publisher.Publish(ctx, events.TopicDonationUnassigned, in.donationID,
		payload, in.traceID, payload.EventID)
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

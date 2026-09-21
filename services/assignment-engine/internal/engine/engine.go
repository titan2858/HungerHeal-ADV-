// Package engine orchestrates one donation's journey from "created" to
// "offered to three agents" (or "nobody found").
//
// It depends on INTERFACES, not on Redis and Kafka directly, so the whole
// decision flow - radius expansion, eligibility, the no-agents path - can be
// unit-tested with fakes and no infrastructure at all. The same separation that
// makes the scoring package testable, applied one level up.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"hungerheal/assignment-engine/internal/domain"
	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/logging"
	"hungerheal/assignment-engine/internal/scoring"
)

// CandidateSource finds agents near a point. Implemented by candidates.Finder
// against Redis, and by a fake in the tests.
type CandidateSource interface {
	FindWithin(ctx context.Context, lat, lng, radiusKm float64, limit int) ([]domain.Candidate, error)
}

// Publisher emits events. Implemented by events.Producer against Kafka.
type Publisher interface {
	Publish(ctx context.Context, topic, key string, payload any, traceID, eventID string) error
}

type Engine struct {
	Candidates     CandidateSource
	Publisher      Publisher
	Logger         *slog.Logger
	OfferBatchSize int
	MaxCandidates  int
}

// Result records what happened, for logging and for the tests to assert on.
type Result struct {
	Assigned        bool
	Offers          []events.Offer
	Reason          events.UnassignedReason
	RadiusUsedKm    float64
	RadiusAttempts  int
	CandidatesFound int
	Eligible        int
}

// Handle processes one donation.created event.
//
// The flow:
//  1. no coordinates        -> unassigned (NOT_GEOCODED), not retryable yet
//  2. widen the radius until candidates appear
//  3. score, filter, take the top N
//  4. publish donation.assigned, or unassigned with a reason
func (e *Engine) Handle(ctx context.Context, evt events.DonationCreated) (Result, error) {
	log := logging.FromContext(ctx, e.Logger).With(
		"donationId", evt.DonationID,
		"category", evt.Category,
	)

	// A donation whose address never resolved has no point to search around.
	// Publishing the reason rather than dropping it is what keeps the plan's
	// promise that a donation never silently disappears.
	if evt.Pickup.Lat == nil || evt.Pickup.Lng == nil {
		log.Warn("donation has no coordinates; cannot be matched")
		res := Result{Reason: events.ReasonNotGeocoded}
		return res, e.publishUnassigned(ctx, evt, res,
			"the pickup address has not been geocoded, so no agents can be searched for")
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

	ladder := scoring.RadiusLadderKm(evt.Category)
	urgency := scoring.UrgencyOf(evt.Category)

	var (
		ranked       []scoring.ScoredAgent
		usedRadius   float64
		attempts     int
		foundAtAll   int
		lastEligible int
	)

	// Widen until somebody eligible turns up. The ladder's shape comes from
	// urgency: hot food jumps to 12km then 25km, tinned goods creep out to 8km
	// then 12km looking for a better local match.
	for _, radiusKm := range ladder {
		attempts++
		usedRadius = radiusKm

		found, err := e.Candidates.FindWithin(ctx, donation.Lat, donation.Lng, radiusKm, e.MaxCandidates)
		if err != nil {
			// A Redis failure is NOT "no agents found" - saying so would
			// publish a wrong answer and mark the donation as handled. Returned
			// as an error instead, so the Kafka offset is not committed and the
			// message is retried.
			return Result{}, fmt.Errorf("candidate lookup failed at %.0fkm: %w", radiusKm, err)
		}

		if len(found) > foundAtAll {
			foundAtAll = len(found)
		}

		// All the matching RULES live in the pure scoring package - category
		// eligibility, availability, exclusions - so there is exactly one place
		// to look when a decision is surprising.
		ranked = scoring.RankAgents(donation, found, radiusKm, nil)
		lastEligible = len(ranked)

		log.Debug("radius attempt",
			"radiusKm", radiusKm, "found", len(found), "eligible", len(ranked))

		if len(ranked) > 0 {
			break
		}
	}

	if len(ranked) == 0 {
		// Distinguishing these two matters: "nobody is online here" is worth
		// retrying in ten minutes, while "three agents are nearby but none of
		// them carry cooked food" needs a different answer entirely.
		reason := events.ReasonNoAgentsFound
		message := fmt.Sprintf("no agents online within %.0fkm", usedRadius)
		if foundAtAll > 0 {
			reason = events.ReasonNoEligibleAgents
			message = fmt.Sprintf("%d agents nearby, but none available for %s", foundAtAll, evt.Category)
		}

		log.Warn("no agent could be matched",
			"reason", reason, "radiusKm", usedRadius, "candidatesFound", foundAtAll)

		res := Result{
			Reason:          reason,
			RadiusUsedKm:    usedRadius,
			RadiusAttempts:  attempts,
			CandidatesFound: foundAtAll,
		}
		return res, e.publishUnassigned(ctx, evt, res, message)
	}

	top := scoring.TopN(ranked, e.OfferBatchSize)

	offers := make([]events.Offer, 0, len(top))
	for i, s := range top {
		offers = append(offers, events.Offer{
			AgentID:   s.Candidate.AgentID,
			AgentName: s.Candidate.Name,
			Phone:     s.Candidate.Phone,
			Rank:      i + 1,
			Score:     s.Score,
			Breakdown: s.Breakdown,
		})
	}

	assigned := events.DonationAssigned{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationAssigned,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      evt.TraceID,

		DonationID: evt.DonationID,
		DonorID:    evt.DonorID,
		Category:   evt.Category,

		Offers:             offers,
		SearchRadiusKm:     usedRadius,
		RadiusAttempts:     attempts,
		CandidatesFound:    foundAtAll,
		CandidatesEligible: lastEligible,

		// Urgency shows up HERE - as a deadline - and never in the score.
		ResponseTimeoutSeconds: int(scoring.ResponseTimeout(evt.Category).Seconds()),
		Urgency:                string(urgency),
	}
	assigned.Pickup.Address = evt.Pickup.Address
	assigned.Pickup.Lat = donation.Lat
	assigned.Pickup.Lng = donation.Lng

	log.Info("donation offered to agents",
		"offers", len(offers),
		"topAgent", offers[0].AgentID,
		"topScore", offers[0].Score,
		"radiusKm", usedRadius,
		"radiusAttempts", attempts,
		"eligible", lastEligible,
		"timeoutSeconds", assigned.ResponseTimeoutSeconds)

	if err := e.Publisher.Publish(ctx, events.TopicDonationAssigned, evt.DonationID,
		assigned, evt.TraceID, assigned.EventID); err != nil {
		return Result{}, fmt.Errorf("could not publish donation.assigned: %w", err)
	}

	return Result{
		Assigned:        true,
		Offers:          offers,
		RadiusUsedKm:    usedRadius,
		RadiusAttempts:  attempts,
		CandidatesFound: foundAtAll,
		Eligible:        lastEligible,
	}, nil
}

func (e *Engine) publishUnassigned(ctx context.Context, evt events.DonationCreated, res Result, message string) error {
	payload := events.DonationUnassigned{
		EventID:      uuid.NewString(),
		EventType:    events.TopicDonationUnassigned,
		EventVersion: 1,
		OccurredAt:   time.Now().UTC(),
		TraceID:      evt.TraceID,

		DonationID: evt.DonationID,
		DonorID:    evt.DonorID,
		Category:   evt.Category,
		Reason:     res.Reason,
		Message:    message,

		SearchedRadiusKm: res.RadiusUsedKm,
		CandidatesFound:  res.CandidatesFound,
		// A missing geocode will not fix itself by waiting; agents coming
		// online will. The retry policy branches on exactly this.
		Retryable: res.Reason != events.ReasonNotGeocoded,
	}

	return e.Publisher.Publish(ctx, events.TopicDonationUnassigned, evt.DonationID,
		payload, evt.TraceID, payload.EventID)
}

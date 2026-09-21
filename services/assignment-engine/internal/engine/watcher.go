package engine

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"hungerheal/assignment-engine/internal/events"
	"hungerheal/assignment-engine/internal/logging"
	"hungerheal/assignment-engine/internal/offers"
)

// DeadlineStore is the slice of the offer store the watcher needs.
type DeadlineStore interface {
	DueNow(ctx context.Context, now time.Time, limit int64) ([]string, error)
	TakeDeadline(ctx context.Context, donationID string) (bool, error)
	GetState(ctx context.Context, donationID string) (*offers.State, error)
	ClaimedBy(ctx context.Context, donationID string) (string, error)
}

// Watcher is what makes the 90-second response window real.
//
// Before this, the timeout was a number stamped on an event that no code ever
// read: if all three offered agents ignored the notification, the donation sat
// there forever and the donor watched a spinner while the food spoiled.
//
// It polls rather than subscribing. Redis CAN notify on key expiry, but those
// notifications are fire-and-forget - delivered only to subscribers connected
// at that exact moment. Restart this service during a deploy and every deadline
// in that window is silently lost. A sorted set of deadlines is durable state,
// so a restart loses nothing: the watcher simply finds the overdue offers on
// its next pass.
type Watcher struct {
	Store     DeadlineStore
	Publisher Publisher
	Logger    *slog.Logger
	Interval  time.Duration
	BatchSize int64
}

// Run polls until the context is cancelled.
func (w *Watcher) Run(ctx context.Context) {
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()

	w.Logger.Info("offer deadline watcher started", "intervalSeconds", w.Interval.Seconds())

	for {
		select {
		case <-ctx.Done():
			w.Logger.Info("offer deadline watcher stopped")
			return
		case <-ticker.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			if n, err := w.Sweep(sweepCtx); err != nil {
				w.Logger.Warn("deadline sweep failed", "err", err.Error())
			} else if n > 0 {
				w.Logger.Info("expired offers swept", "count", n)
			}
			cancel()
		}
	}
}

// Sweep publishes donation.timeout for every offer whose window has closed.
func (w *Watcher) Sweep(ctx context.Context) (int, error) {
	due, err := w.Store.DueNow(ctx, time.Now().UTC(), w.BatchSize)
	if err != nil {
		return 0, err
	}

	published := 0
	for _, donationID := range due {
		// Claim the deadline before acting on it. Every engine instance polls
		// the same sorted set and will all see this donation, but ZREM returns
		// 1 for exactly one of them - so one expiry produces one timeout event,
		// however many instances are running.
		mine, err := w.Store.TakeDeadline(ctx, donationID)
		if err != nil {
			w.Logger.Warn("could not take the deadline", "donationId", donationID, "err", err.Error())
			continue
		}
		if !mine {
			continue
		}

		state, err := w.Store.GetState(ctx, donationID)
		if err != nil || state == nil {
			// The state expired, so there is nothing to re-score against. The
			// deadline is already removed, which is the right outcome.
			w.Logger.Warn("expired offer has no state; dropping the deadline", "donationId", donationID)
			continue
		}

		// An accept may have landed between the deadline passing and this
		// sweep. Re-offering then would send a second agent to a donation
		// somebody is already driving to.
		if claimed, err := w.Store.ClaimedBy(ctx, donationID); err == nil && claimed != "" {
			w.Logger.Debug("offer expired but was already accepted",
				"donationId", donationID, "agentId", claimed)
			continue
		}

		evt := events.DonationTimeout{
			EventID:      uuid.NewString(),
			EventType:    events.TopicDonationTimeout,
			EventVersion: 1,
			OccurredAt:   time.Now().UTC(),
			// The donor's original traceId, so the re-offer appears under the
			// same trace as the request that created the donation minutes ago.
			TraceID: state.TraceID,

			DonationID: donationID,
			DonorID:    state.DonorID,
			Category:   state.Category,
			Round:      state.Round,
			OfferedTo:  state.OfferedTo,
			RadiusKm:   state.RadiusKm,
		}

		log := logging.FromContext(logging.WithTrace(ctx, state.TraceID), w.Logger)
		log.Info("offer window closed with no response",
			"donationId", donationID, "round", state.Round, "offeredTo", len(state.OfferedTo))

		if err := w.Publisher.Publish(ctx, events.TopicDonationTimeout, donationID,
			evt, state.TraceID, evt.EventID); err != nil {
			// The deadline has already been removed, so this donation would
			// stall with nothing to re-arm it. Logged loudly as a real gap.
			log.Error("could not publish donation.timeout", "donationId", donationID, "err", err.Error())
			continue
		}

		published++
	}

	return published, nil
}

package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"hungerheal/assignment-engine/internal/engine"
	"hungerheal/assignment-engine/internal/httpx"
	"hungerheal/assignment-engine/internal/offers"
)

// The engine's only request API: how an agent answers an offer.
//
// It lives here rather than in tracking-service because the CLAIM LOCK lives
// here. Accepting is not a status update - it is winning a race between three
// agents who were notified at the same moment, and the service that made the
// offers is the one that can arbitrate it atomically. tracking-service consumes
// the resulting donation.accepted event to drive status and notifications.
type Handlers struct {
	Engine *engine.Engine
	Logger *slog.Logger
}

type rejectRequest struct {
	Reason string `json:"reason"`
}

// Accept: POST /offers/{donationId}/accept
func (h *Handlers) Accept(w http.ResponseWriter, r *http.Request) {
	donationID := r.PathValue("donationId")
	user, _ := httpx.UserFrom(r.Context())

	// The agent id comes from the verified token, never the body, so one agent
	// cannot accept on another's behalf.
	result, err := h.Engine.Accept(r.Context(), donationID, user.ID, user.Name, user.Phone)

	switch {
	case errors.Is(err, offers.ErrAlreadyClaimed):
		// 409 rather than an error page. Losing the race is a normal outcome of
		// offering in parallel, and the app should close the notification
		// cleanly rather than show a failure.
		httpx.Error(w, r, http.StatusConflict, "ALREADY_CLAIMED",
			"another agent accepted this donation first")
		return
	case errors.Is(err, engine.ErrNotOffered):
		// Deliberately a 404, not a 403: a 403 would confirm the donation id is
		// real, letting an agent probe for donations offered to other people.
		httpx.NotFound(w, r, "no open offer for you on this donation")
		return
	case errors.Is(err, engine.ErrOfferExpired):
		httpx.Error(w, r, http.StatusGone, "OFFER_EXPIRED",
			"this offer has expired and the donation has moved on")
		return
	case err != nil:
		h.Logger.Error("accept failed", "donationId", donationID, "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"accepted": true,
		"donation": result,
	})
}

// Reject: POST /offers/{donationId}/reject
func (h *Handlers) Reject(w http.ResponseWriter, r *http.Request) {
	donationID := r.PathValue("donationId")
	user, _ := httpx.UserFrom(r.Context())

	var body rejectRequest
	_ = json.NewDecoder(r.Body).Decode(&body) // a reason is optional

	remaining, err := h.Engine.Reject(r.Context(), donationID, user.ID, body.Reason)

	switch {
	case errors.Is(err, engine.ErrNotOffered):
		httpx.NotFound(w, r, "no open offer for you on this donation")
		return
	case errors.Is(err, engine.ErrOfferExpired):
		httpx.Error(w, r, http.StatusGone, "OFFER_EXPIRED", "this offer has already expired")
		return
	case err != nil:
		h.Logger.Error("reject failed", "donationId", donationID, "err", err.Error())
		httpx.Internal(w, r)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"rejected": true,
		// When this hits zero the engine re-scores immediately rather than
		// waiting out a deadline nobody is going to meet.
		"remainingInBatch": remaining,
	})
}

// Offer: GET /offers/{donationId} - what the agent app polls to see whether an
// offer is still open before showing an Accept button.
func (h *Handlers) Offer(w http.ResponseWriter, r *http.Request) {
	donationID := r.PathValue("donationId")
	user, _ := httpx.UserFrom(r.Context())

	state, err := h.Engine.Offers.GetState(r.Context(), donationID)
	if err != nil {
		httpx.Internal(w, r)
		return
	}
	if state == nil {
		httpx.NotFound(w, r, "no offer on record for this donation")
		return
	}

	offered := false
	for _, id := range state.OfferedTo {
		if id == user.ID {
			offered = true
			break
		}
	}
	if !offered {
		httpx.NotFound(w, r, "no open offer for you on this donation")
		return
	}

	claimedBy, _ := h.Engine.Offers.ClaimedBy(r.Context(), donationID)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"donationId": donationID,
		"round":      state.Round,
		"address":    state.Address,
		"lat":        state.Lat,
		"lng":        state.Lng,
		"category":   state.Category,
		"expiresAt":  state.ExpiresAt,
		// Lets the app grey out the button the moment someone else wins,
		// instead of only finding out when Accept returns a 409.
		"open":      claimedBy == "",
		"claimedBy": claimedBy,
	})
}

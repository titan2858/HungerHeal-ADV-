import { useState } from 'react';
import { api } from '../api/client';
import { useCountdown } from '../hooks/useOffers';

/**
 * One collection request, with the clock running.
 *
 * Three agents see this card at the same moment and only one of them can win.
 * Most of the work here is making that race feel like a normal part of the job
 * rather than an error.
 */
export default function OfferCard({ offer, onAnswered }) {
  const secondsLeft = useCountdown(offer.expiresAt);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);

  async function accept() {
    setBusy(true);
    try {
      const res = await api.acceptOffer(offer.donationId);
      setOutcome({ kind: 'won', donation: res.donation });
      onAnswered?.(offer.donationId, 'accepted');
    } catch (err) {
      if (err.status === 409) {
        // Losing the race is a normal outcome of being asked in parallel, not
        // a failure. Saying so plainly is the difference between "the app is
        // broken" and "someone was quicker".
        setOutcome({ kind: 'taken' });
        onAnswered?.(offer.donationId, 'taken');
      } else if (err.status === 410) {
        setOutcome({ kind: 'expired' });
        onAnswered?.(offer.donationId, 'expired');
      } else {
        setOutcome({ kind: 'error', message: err.message });
      }
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api.rejectOffer(offer.donationId, 'declined in app');
      setOutcome({ kind: 'declined' });
      onAnswered?.(offer.donationId, 'declined');
    } catch (err) {
      setOutcome({ kind: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (outcome) {
    return (
      <li className={`offer resolved ${outcome.kind}`}>
        <strong>{offer.title}</strong>
        <p className="muted">
          {outcome.kind === 'won' && 'Yours — head to the pickup address.'}
          {outcome.kind === 'taken' && 'Another agent accepted this one first.'}
          {outcome.kind === 'expired' && 'This request expired.'}
          {outcome.kind === 'declined' && 'Declined. It has gone to other agents.'}
          {outcome.kind === 'error' && `Something went wrong: ${outcome.message}`}
        </p>
      </li>
    );
  }

  // Expired while on screen. The card stays visible for a moment rather than
  // vanishing mid-tap, which would leave the agent unsure what happened.
  if (secondsLeft <= 0) {
    return (
      <li className="offer resolved expired">
        <strong>{offer.title}</strong>
        <p className="muted">This request expired before it was answered.</p>
      </li>
    );
  }

  // Under 30 seconds the countdown turns urgent. The window is 90 seconds, so
  // this is the last third.
  const urgent = secondsLeft <= 30;

  return (
    <li className={`offer ${urgent ? 'urgent' : ''}`}>
      <div className="offer-head">
        <strong>{offer.title}</strong>
        <span className={`countdown ${urgent ? 'urgent' : ''}`}>{secondsLeft}s</span>
      </div>

      <p className="offer-body">{offer.body}</p>

      {offer.meta?.rank && (
        // Shown because it explains WHY they were asked, and sets expectations:
        // being ranked #3 of 3 means two better-suited agents were asked first.
        <p className="muted">
          Ranked #{offer.meta.rank} for this pickup
          {offer.meta.round > 1 && ` · round ${offer.meta.round}`}
        </p>
      )}

      <div className="offer-actions">
        <button type="button" onClick={accept} disabled={busy}>
          {busy ? 'Working…' : 'Accept'}
        </button>
        <button type="button" className="secondary" onClick={decline} disabled={busy}>
          Decline
        </button>
      </div>
    </li>
  );
}

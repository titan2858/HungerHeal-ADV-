import { motion } from 'framer-motion';
import { CheckCircle2, Clock, Trophy, XCircle } from 'lucide-react';
import { useState } from 'react';
import Button from './ui/Button';
import { api } from '../api/client';
import { useCountdown } from '../hooks/useOffers';

const RESOLVED = {
  won: { text: 'Yours — head to the pickup address.', tone: 'border-leaf-300 bg-leaf-50 text-leaf-800', Icon: CheckCircle2 },
  taken: { text: 'Another agent accepted this one first.', tone: 'border-cream-300 bg-cream-100 text-ink-600', Icon: Trophy },
  expired: { text: 'This request expired.', tone: 'border-cream-300 bg-cream-100 text-ink-500', Icon: Clock },
  declined: { text: 'Declined. It has gone to other agents.', tone: 'border-cream-300 bg-cream-100 text-ink-500', Icon: XCircle },
};

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
    const resolved =
      RESOLVED[outcome.kind] ?? {
        text: `Something went wrong: ${outcome.message}`,
        tone: 'border-red-200 bg-red-50 text-red-700',
        Icon: XCircle,
      };
    const { Icon } = resolved;

    return (
      <motion.li
        layout
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 1 }}
        className={`rounded-xl2 border px-5 py-4 ${resolved.tone}`}
      >
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{offer.title}</p>
            <p className="mt-0.5 text-sm opacity-90">{resolved.text}</p>
          </div>
        </div>
      </motion.li>
    );
  }

  // Expired while on screen. The card stays visible for a moment rather than
  // vanishing mid-tap, which would leave the agent unsure what happened.
  if (secondsLeft <= 0) {
    return (
      <motion.li
        layout
        className="rounded-xl2 border border-cream-300 bg-cream-100 px-5 py-4 text-ink-500"
      >
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{offer.title}</p>
            <p className="mt-0.5 text-sm">This request expired before it was answered.</p>
          </div>
        </div>
      </motion.li>
    );
  }

  // Under 30 seconds the countdown turns urgent. The window is 90 seconds, so
  // this is the last third.
  const urgent = secondsLeft <= 30;

  // The bar is proportional to the full window, so it reads as time running out
  // rather than as a number that happens to be getting smaller.
  const windowSeconds = offer.meta?.windowSeconds ?? 90;
  const fraction = Math.max(0, Math.min(1, secondsLeft / windowSeconds));

  return (
    <motion.li
      layout
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={[
        'rounded-xl2 border-2 bg-white p-5 shadow-soft transition-colors',
        urgent ? 'border-red-300' : 'border-leaf-300',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-ink-900">{offer.title}</h3>
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-sm font-bold tabular-nums',
            urgent ? 'bg-red-100 text-red-700' : 'bg-leaf-100 text-leaf-700',
          ].join(' ')}
          // Announced on the minute-ish rather than every tick, so a screen
          // reader is not reading a stopwatch aloud.
          role="timer"
          aria-live="off"
        >
          <Clock className={`size-3.5 ${urgent ? 'animate-pulse' : ''}`} aria-hidden="true" />
          {secondsLeft}s
        </span>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-cream-200"
        role="progressbar"
        aria-valuenow={secondsLeft}
        aria-valuemin={0}
        aria-valuemax={windowSeconds}
        aria-label="Time left to respond"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-1000 ease-linear ${
            urgent ? 'bg-red-500' : 'bg-leaf-500'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>

      <p className="mt-4 text-sm leading-relaxed text-ink-600">{offer.body}</p>

      {offer.meta?.rank && (
        // Shown because it explains WHY they were asked, and sets expectations:
        // being ranked #3 of 3 means two better-suited agents were asked first.
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-cream-100 px-2.5 py-1 text-xs font-medium text-ink-500">
          <Trophy className="size-3.5 text-warm-600" aria-hidden="true" />
          Ranked #{offer.meta.rank} for this pickup
          {offer.meta.round > 1 && ` · round ${offer.meta.round}`}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <Button onClick={accept} loading={busy} disabled={busy} className="flex-1">
          {busy ? 'Working…' : 'Accept'}
        </Button>
        <Button variant="outline" onClick={decline} disabled={busy}>
          Decline
        </Button>
      </div>
    </motion.li>
  );
}

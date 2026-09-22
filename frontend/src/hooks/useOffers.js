import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

// How often the agent's inbox is polled.
//
// Offers live for 90 seconds. Polling every 5s means an agent sees a request
// within 5s of it being made, leaving them ~85s to decide - and costs 12
// requests a minute per agent, which is unremarkable.
//
// This is the crude part of the system and worth naming: server-sent events or
// a websocket would deliver an offer the instant it exists, rather than up to
// a poll interval later. For a 90-second window, 5s of latency is acceptable;
// for a 20-second window it would not be.
const POLL_INTERVAL_MS = 5000;

/**
 * The agent's live view: open offers, and everything else in their inbox.
 */
export function useOffers({ enabled = true } = {}) {
  const [offers, setOffers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Guards against a slow earlier poll landing after a newer one and
  // overwriting fresher state with stale data.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;

    try {
      const res = await api.notifications('?limit=50');
      if (id !== requestId.current) return;

      const all = res.notifications ?? [];

      // An offer is only actionable while it is open. The server already
      // filters expired ones out, but a notification can expire between the
      // response being built and the agent looking at the screen, so it is
      // filtered again here against the clock rather than trusted.
      const open = all.filter(
        (n) => n.kind === 'OFFER' && n.expiresAt && new Date(n.expiresAt) > new Date(),
      );

      setOffers(open);
      setNotifications(all);
      setUnread(res.unreadCount ?? 0);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  // Removes an offer from the list at once, without waiting for the next poll.
  // Leaving a countdown ticking on a donation the agent just answered makes the
  // app feel broken even though the answer landed.
  const dismissOffer = useCallback((donationId) => {
    setOffers((current) => current.filter((o) => o.donationId !== donationId));
  }, []);

  return { offers, notifications, unread, error, loading, refresh, dismissOffer };
}

/**
 * A countdown that re-renders once a second.
 *
 * Kept as a hook rather than a prop so only the component showing the timer
 * re-renders, instead of the whole dashboard every second.
 */
export function useCountdown(expiresAt) {
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(expiresAt));

  useEffect(() => {
    setSecondsLeft(remaining(expiresAt));

    const timer = setInterval(() => {
      const left = remaining(expiresAt);
      setSecondsLeft(left);
      if (left <= 0) clearInterval(timer);
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  return secondsLeft;
}

function remaining(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
}

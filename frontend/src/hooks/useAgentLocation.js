import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

// How often the agent's position is sent while they are on shift.
//
// The backend trusts a reported location for AGENT_TTL_SECONDS (120s) and then
// the reaper removes them from the geo set entirely. Reporting every 20s gives
// six chances to survive a lapse before that happens - a tunnel, a lift, a few
// seconds of no signal. Reporting every 110s would technically satisfy the TTL
// and would drop the agent out of matching the first time one request failed.
const REPORT_INTERVAL_MS = 20_000;

/**
 * Keeps an agent visible to the matching engine.
 *
 * Returns the current position, whether sharing is on, and the last error -
 * because "why am I not getting any offers?" is the question this hook's state
 * has to be able to answer.
 */
export function useAgentLocation() {
  const [sharing, setSharing] = useState(false);
  const [position, setPosition] = useState(null);
  const [lastReportedAt, setLastReportedAt] = useState(null);
  const [error, setError] = useState(null);

  const watchId = useRef(null);
  const timerId = useRef(null);
  // Read by the interval without making it a dependency, so the interval is
  // not torn down and rebuilt on every GPS tick.
  const latest = useRef(null);

  const report = useCallback(async () => {
    const current = latest.current;
    if (!current) return;

    try {
      await api.reportLocation(current.lat, current.lng);
      setLastReportedAt(new Date());
      setError(null);
    } catch (err) {
      // Non-fatal: the browser still has a position, and the next tick will
      // try again. Surfaced so an agent can tell "no offers because nobody
      // needs me" from "no offers because the server never heard from me".
      setError(`Could not report location: ${err.message}`);
    }
  }, []);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError('This browser cannot share location.');
      return;
    }

    setError(null);

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        latest.current = next;
        setPosition(next);
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Agents cannot be matched without it.'
            : `Location unavailable: ${err.message}`,
        );
        setSharing(false);
      },
      // enableHighAccuracy because a pickup is a doorway, not a neighbourhood,
      // and distance is 35% of whether this agent wins the donation.
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );

    setSharing(true);
  }, []);

  const stop = useCallback(async () => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (timerId.current) {
      clearInterval(timerId.current);
      timerId.current = null;
    }
    setSharing(false);

    try {
      // Explicitly offline rather than waiting for the heartbeat to lapse.
      // Otherwise the agent keeps receiving offers for up to two minutes after
      // ending their shift, and every one of those offers times out and delays
      // a donation.
      await api.goOffline();
    } catch {
      /* the heartbeat will expire on its own */
    }
  }, []);

  // Report on a fixed interval, and once immediately, so an agent who just came
  // on shift is matchable straight away rather than after the first tick.
  useEffect(() => {
    if (!sharing) return undefined;

    report();
    timerId.current = setInterval(report, REPORT_INTERVAL_MS);

    return () => {
      if (timerId.current) clearInterval(timerId.current);
      timerId.current = null;
    };
  }, [sharing, report]);

  // Stop the GPS watch if the component unmounts while sharing, so a closed tab
  // does not leave a watch running.
  useEffect(
    () => () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      if (timerId.current) clearInterval(timerId.current);
    },
    [],
  );

  return { sharing, position, lastReportedAt, error, start, stop, reportNow: report };
}

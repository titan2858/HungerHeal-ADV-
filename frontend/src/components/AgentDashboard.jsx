import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAgentLocation } from '../hooks/useAgentLocation';
import { useOffers } from '../hooks/useOffers';
import OfferCard from './OfferCard';

/**
 * The agent's whole working surface: go on shift, receive requests, accept
 * them, collect the food.
 */
export default function AgentDashboard({ user }) {
  const { sharing, position, lastReportedAt, error: locationError, start, stop } =
    useAgentLocation();

  // Offers are only polled while on shift. Polling every five seconds for an
  // agent who has finished work is pure waste - and they cannot be offered
  // anything anyway, because their heartbeat has lapsed.
  const { offers, notifications, unread, refresh, dismissOffer } = useOffers({
    enabled: sharing,
  });

  const [available, setAvailable] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);

  // What the agent has accepted and not yet collected.
  const loadJobs = useCallback(async () => {
    try {
      const res = await api.listTracking('?status=ACCEPTED');
      setJobs(res.tracking ?? []);
    } catch (err) {
      if (err.status !== 401) setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, 15_000);
    return () => clearInterval(timer);
  }, [loadJobs]);

  async function toggleAvailability() {
    const next = !available;
    setAvailable(next);
    try {
      await api.setAvailability(next);
    } catch (err) {
      setAvailable(!next); // put the switch back if the server refused
      setError(err.message);
    }
  }

  async function collect(donationId) {
    try {
      await api.markCollected(donationId);
      // The status becomes COLLECTED once tracking-service consumes its own
      // event, so the list is refreshed after a moment rather than assuming.
      setTimeout(loadJobs, 2500);
    } catch (err) {
      setError(err.message);
    }
  }

  const onAnswered = useCallback(
    (donationId, outcome) => {
      dismissOffer(donationId);
      if (outcome === 'accepted') {
        setTimeout(loadJobs, 1500);
        refresh();
      }
    },
    [dismissOffer, loadJobs, refresh],
  );

  return (
    <>
      {/* ------------------------------------------------------- shift ---- */}
      <div className="card">
        <div className="card-head">
          <h2>{sharing ? 'On shift' : 'Off shift'}</h2>
          <button type="button" className={sharing ? 'secondary' : ''} onClick={sharing ? stop : start}>
            {sharing ? 'End shift' : 'Go on shift'}
          </button>
        </div>

        {!sharing && (
          <p className="hint">
            Sharing your location is what makes you matchable. Nothing will be offered to you
            until you go on shift.
          </p>
        )}

        {locationError && <pre className="error">{locationError}</pre>}

        {sharing && (
          <>
            <div className="shift-row">
              <span className="dot live" /> Location shared
              {position && (
                <span className="muted">
                  {' '}· {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                  {position.accuracy && ` (±${Math.round(position.accuracy)}m)`}
                </span>
              )}
            </div>
            {lastReportedAt && (
              // Shown because "why am I not getting offers?" is usually
              // answered here: if this stops updating, the server has stopped
              // hearing from this device.
              <p className="muted">
                Last reported {lastReportedAt.toLocaleTimeString()} · reporting every 20s
              </p>
            )}

            <label className="check availability">
              <input type="checkbox" checked={available} onChange={toggleAvailability} />
              Accepting new requests
            </label>
            {!available && (
              <p className="hint">
                You stay on the map, but nothing new will be offered to you.
              </p>
            )}
          </>
        )}
      </div>

      {error && <pre className="error">{error}</pre>}

      {/* ------------------------------------------------------ offers ---- */}
      <div className="card">
        <div className="card-head">
          <h2>Collection requests</h2>
          {unread > 0 && <span className="badge">{unread}</span>}
        </div>

        {!sharing ? (
          <p className="hint">Go on shift to receive requests.</p>
        ) : offers.length === 0 ? (
          <p className="hint">Nothing right now. This checks every 5 seconds.</p>
        ) : (
          <ul className="offers">
            {offers.map((offer) => (
              <OfferCard key={offer.id} offer={offer} onAnswered={onAnswered} />
            ))}
          </ul>
        )}
      </div>

      {/* -------------------------------------------------------- jobs ---- */}
      <div className="card">
        <div className="card-head">
          <h2>To collect</h2>
          <button type="button" className="secondary" onClick={loadJobs}>
            Refresh
          </button>
        </div>

        {jobs.length === 0 ? (
          <p className="hint">Nothing accepted yet.</p>
        ) : (
          <ul className="donations">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className="donation-head">
                  <strong>{job.category?.replace(/_/g, ' ').toLowerCase()}</strong>
                  <span className="status-pill accepted">to collect</span>
                </div>
                <p className="muted">{job.message}</p>
                {job.timeline?.length > 0 && (
                  <p className="muted">{job.timeline[job.timeline.length - 1].summary}</p>
                )}
                <button type="button" onClick={() => collect(job.donationId)}>
                  Mark collected
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ------------------------------------------------------ inbox ----- */}
      {notifications.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Recent</h2>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                await api.markAllRead();
                refresh();
              }}
            >
              Mark all read
            </button>
          </div>
          <ul className="notifications">
            {notifications.slice(0, 8).map((n) => (
              <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
                <strong>{n.title}</strong>
                <p className="muted">{n.body}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

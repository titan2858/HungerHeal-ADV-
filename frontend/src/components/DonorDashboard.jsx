import { useCallback, useEffect, useState } from 'react';
import DonationForm from './DonationForm';
import DonationCard from './DonationCard';
import DonorStats from './DonorStats';
import { api, auth } from '../api/client';

// The statuses a donor can filter by, grouped the way they think about them
// rather than the way the state machine names them.
const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'active', label: 'In progress', match: (t) => ['PENDING_ASSIGNMENT', 'OFFERED', 'ACCEPTED'].includes(t.status) },
  { key: 'collected', label: 'Collected', match: (t) => t.status === 'COLLECTED' },
  { key: 'stuck', label: 'Needs attention', match: (t) => t.status === 'UNASSIGNED' },
];

export default function DonorDashboard() {
  const [tracking, setTracking] = useState([]);
  const [summary, setSummary] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    if (!auth.token) return;

    try {
      // Read from tracking-service, not donation-service. donation-service sets
      // PENDING_ASSIGNMENT at creation and never hears about the rest, so its
      // status field goes stale the moment an agent is offered the donation.
      const [list, stats, notes] = await Promise.all([
        api.listTracking('?limit=50'),
        api.trackingSummary().catch(() => null),
        api.notifications('?limit=10').catch(() => null),
      ]);

      setTracking(list.tracking ?? []);
      setSummary(stats);
      setNotifications(notes?.notifications ?? []);
      setError(null);
    } catch (err) {
      if (err.status === 401) {
        auth.clear();
        window.location.reload();
        return;
      }
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    // A donation can go from offered to accepted within seconds, so the view
    // refreshes itself rather than needing a reload. 10s is unobtrusive for a
    // page someone leaves open while waiting.
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const visible = tracking.filter(active.match);

  const needsAttention = tracking.filter((t) => t.status === 'UNASSIGNED');
  const unread = notifications.filter((n) => !n.readAt);

  return (
    <>
      {/* Anything the donor should act on goes first, before the stats. */}
      {needsAttention.length > 0 && (
        <div className="card attention">
          <h2>Needs attention</h2>
          {needsAttention.map((t) => (
            <p key={t.id}>
              <strong>{t.title || t.category?.replace(/_/g, ' ').toLowerCase()}</strong> — {t.message}
            </p>
          ))}
        </div>
      )}

      <DonorStats summary={summary} />

      <div className="card">
        <div className="card-head">
          <h2>Offer food</h2>
          <button
            type="button"
            className={showForm ? 'secondary' : ''}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? 'Close' : 'New donation'}
          </button>
        </div>

        {showForm ? (
          <DonationForm
            onCreated={() => {
              // The pipeline takes a moment: created, then geocoded, then
              // offered. Refreshing immediately would show it as still pending.
              setTimeout(refresh, 2500);
              setShowForm(false);
            }}
          />
        ) : (
          <p className="hint">Post surplus food and an agent is found automatically.</p>
        )}
      </div>

      {error && <pre className="error">{error}</pre>}

      <div className="card">
        <div className="card-head">
          <h2>Your donations</h2>
          <button type="button" className="secondary" onClick={refresh}>
            Refresh
          </button>
        </div>

        {tracking.length > 0 && (
          <div className="filters">
            {FILTERS.map((f) => {
              const count = tracking.filter(f.match).length;
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`chip ${filter === f.key ? 'on' : ''}`}
                  onClick={() => setFilter(f.key)}
                  // A filter that would show nothing is disabled rather than
                  // hidden, so the set of options does not shift around.
                  disabled={count === 0 && f.key !== 'all'}
                >
                  {f.label} {count > 0 && <span className="chip-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        {!loaded ? (
          <p className="hint">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="hint">
            {tracking.length === 0
              ? 'Nothing yet. Post a donation above and an agent will be found automatically.'
              : `Nothing ${active.label.toLowerCase()}.`}
          </p>
        ) : (
          <ul className="donations">
            {visible.map((t) => (
              <DonationCard key={t.id} tracking={t} />
            ))}
          </ul>
        )}
      </div>

      {notifications.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Updates {unread.length > 0 && <span className="badge">{unread.length}</span>}</h2>
            {unread.length > 0 && (
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
            )}
          </div>
          <ul className="notifications">
            {notifications.slice(0, 6).map((n) => (
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

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Bell, Inbox, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DonationForm from './DonationForm';
import DonationCard from './DonationCard';
import DonorStats from './DonorStats';
import Button from './ui/Button';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import LoadingState from './ui/LoadingState';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { prettyCategory, timeAgo } from '../lib/format';

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
  const [refreshing, setRefreshing] = useState(false);

  const { signOut } = useAuth();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setRefreshing(true);

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
      // An expired token means the session is over, not that the page is
      // broken. Clearing it and routing to login beats a reload loop.
      if (err.status === 401) {
        signOut();
        navigate('/login', { replace: true });
        return;
      }
      setError(err);
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [signOut, navigate]);

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
    <div className="space-y-8">
      {/* Anything the donor should act on goes first, before the stats. */}
      <AnimatePresence>
        {needsAttention.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-xl2 border border-warm-300 bg-warm-50 p-5"
            role="alert"
          >
            <h2 className="flex items-center gap-2 text-base font-semibold text-warm-900">
              <AlertTriangle className="size-4.5" aria-hidden="true" />
              Needs attention
            </h2>
            <ul className="mt-3 space-y-1.5">
              {needsAttention.map((t) => (
                <li key={t.id} className="text-sm text-warm-800">
                  <span className="font-semibold">{t.title || prettyCategory(t.category)}</span>
                  {' — '}
                  {t.message}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <DonorStats summary={summary} />

      {/* ------------------------------------------------------- post food */}
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Offer food</h2>
            <p className="mt-1 text-sm text-ink-500">
              Post surplus food and a collector is found automatically.
            </p>
          </div>
          <Button
            variant={showForm ? 'ghost' : 'primary'}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? (
              <>
                <X className="size-4" aria-hidden="true" />
                Close
              </>
            ) : (
              <>
                <Plus className="size-4" aria-hidden="true" />
                New donation
              </>
            )}
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {showForm && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="pt-6">
                <DonationForm
                  onCreated={() => {
                    // The pipeline takes a moment: created, then geocoded, then
                    // offered. Refreshing immediately would show it as still
                    // pending.
                    setTimeout(refresh, 2500);
                    setShowForm(false);
                  }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {error && <ErrorState error={error} onRetry={refresh} />}

      {/* -------------------------------------------------- their donations */}
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Your donations</h2>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw
              className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>

        {tracking.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter donations">
            {FILTERS.map((f) => {
              const count = tracking.filter(f.match).length;
              const on = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f.key)}
                  // A filter that would show nothing is disabled rather than
                  // hidden, so the set of options does not shift around.
                  disabled={count === 0 && f.key !== 'all'}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors',
                    on
                      ? 'bg-leaf-600 text-white'
                      : 'bg-cream-100 text-ink-500 hover:bg-cream-200 disabled:opacity-40 disabled:hover:bg-cream-100',
                  ].join(' ')}
                >
                  {f.label}
                  {count > 0 && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[0.65rem] ${
                        on ? 'bg-white/20' : 'bg-white'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-6">
          {!loaded ? (
            <LoadingState count={2} label="Loading your donations" />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={tracking.length === 0 ? 'No donations yet' : `Nothing ${active.label.toLowerCase()}`}
              description={
                tracking.length === 0
                  ? 'Post a donation above and a collector will be found automatically — usually within seconds.'
                  : 'Try another filter to see the rest of your donations.'
              }
              action={
                tracking.length === 0
                  ? { label: 'Post a donation', onClick: () => setShowForm(true) }
                  : undefined
              }
            />
          ) : (
            <motion.ul layout className="space-y-4">
              <AnimatePresence mode="popLayout">
                {visible.map((t) => (
                  <DonationCard key={t.id} tracking={t} />
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------- the updates */}
      {notifications.length > 0 && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Bell className="size-5 text-leaf-600" aria-hidden="true" />
              Updates
              {unread.length > 0 && (
                <span className="rounded-full bg-leaf-600 px-2 py-0.5 text-xs font-semibold text-white">
                  {unread.length}
                </span>
              )}
            </h2>
            {unread.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await api.markAllRead();
                  refresh();
                }}
              >
                Mark all read
              </Button>
            )}
          </div>

          <ul className="mt-5 space-y-2">
            {notifications.slice(0, 6).map((n) => (
              <li
                key={n.id}
                className={[
                  'rounded-xl border px-4 py-3',
                  n.readAt
                    ? 'border-cream-200 bg-cream-50'
                    : 'border-leaf-200 bg-leaf-50',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-ink-800">{n.title}</p>
                  {n.createdAt && (
                    <span className="shrink-0 text-xs text-ink-400">{timeAgo(n.createdAt)}</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink-500">{n.body}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

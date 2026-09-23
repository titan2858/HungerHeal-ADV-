import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  BellOff,
  Inbox,
  MapPin,
  PackageCheck,
  Power,
  RefreshCw,
  Satellite,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAgentLocation } from '../hooks/useAgentLocation';
import { useOffers } from '../hooks/useOffers';
import OfferCard from './OfferCard';
import Button from './ui/Button';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import { prettyCategory, timeAgo } from '../lib/format';

/**
 * The agent's whole working surface: go on shift, receive requests, accept
 * them, collect the food.
 */
export default function AgentDashboard() {
  const { sharing, acquiring, position, lastReportedAt, error: locationError, start, stop } =
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
      if (err.status !== 401) setError(err);
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
      setError(err);
    }
  }

  async function collect(donationId) {
    try {
      await api.markCollected(donationId);
      // The status becomes COLLECTED once tracking-service consumes its own
      // event, so the list is refreshed after a moment rather than assuming.
      setTimeout(loadJobs, 2500);
    } catch (err) {
      setError(err);
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
    <div className="space-y-8">
      {/* ----------------------------------------------------------- shift */}
      <Card
        className={[
          'p-6 transition-colors sm:p-8',
          sharing ? 'border-leaf-300 bg-leaf-50/50' : '',
        ].join(' ')}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={[
                'flex size-11 items-center justify-center rounded-xl',
                sharing
                  ? 'bg-leaf-600 text-white'
                  : acquiring
                    ? 'bg-warm-100 text-warm-600'
                    : 'bg-cream-200 text-ink-400',
              ].join(' ')}
            >
              <Satellite
                className={`size-5 ${acquiring ? 'animate-pulse' : ''}`}
                aria-hidden="true"
              />
            </span>
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                {sharing ? 'On shift' : acquiring ? 'Finding your location…' : 'Off shift'}
                {sharing && (
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-leaf-400 opacity-75" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-leaf-500" />
                  </span>
                )}
              </h2>
              <p className="mt-0.5 text-sm text-ink-500">
                {sharing
                  ? 'You are on the map and can be matched.'
                  : acquiring
                    ? 'Waiting for your first GPS fix. Your shift starts the moment it arrives.'
                    : 'Nothing will be offered to you until you go on shift.'}
              </p>
            </div>
          </div>

          <Button
            variant={sharing || acquiring ? 'outline' : 'primary'}
            onClick={sharing || acquiring ? stop : start}
          >
            <Power className="size-4" aria-hidden="true" />
            {sharing ? 'End shift' : acquiring ? 'Cancel' : 'Go on shift'}
          </Button>
        </div>

        {locationError && (
          <div className="mt-5">
            <ErrorState error={{ message: locationError }} />
          </div>
        )}

        <AnimatePresence>
          {sharing && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-6 space-y-4 border-t border-leaf-200 pt-6">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <MapPin className="size-4 text-leaf-600" aria-hidden="true" />
                  <span className="font-medium text-ink-700">Location shared</span>
                  {position && (
                    <span className="font-mono text-xs text-ink-400">
                      {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                      {position.accuracy && ` (±${Math.round(position.accuracy)}m)`}
                    </span>
                  )}
                </div>

                {lastReportedAt && (
                  // Shown because "why am I not getting offers?" is usually
                  // answered here: if this stops updating, the server has
                  // stopped hearing from this device.
                  <p className="text-xs text-ink-400">
                    Last reported {lastReportedAt.toLocaleTimeString()} · reporting every 20s
                  </p>
                )}

                <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-white px-4 py-3">
                  <input
                    type="checkbox"
                    checked={available}
                    onChange={toggleAvailability}
                    className="mt-0.5 size-4 rounded border-cream-300 text-leaf-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink-800">
                      Accepting new requests
                    </span>
                    {!available && (
                      <span className="mt-0.5 block text-xs text-ink-500">
                        You stay on the map, but nothing new will be offered to you.
                      </span>
                    )}
                  </span>
                </label>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {error && <ErrorState error={error} onRetry={loadJobs} />}

      {/* ---------------------------------------------------------- offers */}
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            Collection requests
            {unread > 0 && (
              <span className="rounded-full bg-leaf-600 px-2 py-0.5 text-xs font-semibold text-white">
                {unread}
              </span>
            )}
          </h2>
        </div>

        <div className="mt-6">
          {!sharing ? (
            <EmptyState
              icon={BellOff}
              title="You are off shift"
              description="Go on shift to start receiving collection requests near you."
              action={{ label: 'Go on shift', onClick: start }}
            />
          ) : offers.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Nothing right now"
              description="You are on the map and matchable. This checks every 5 seconds."
            />
          ) : (
            <motion.ul layout className="space-y-4">
              <AnimatePresence mode="popLayout">
                {offers.map((offer) => (
                  <OfferCard key={offer.id} offer={offer} onAnswered={onAnswered} />
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------------ jobs */}
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">To collect</h2>
          <Button variant="ghost" size="sm" onClick={loadJobs}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>

        <div className="mt-6">
          {jobs.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing accepted yet"
              description="Requests you accept will appear here until you mark them collected."
            />
          ) : (
            <ul className="space-y-4">
              {jobs.map((job) => (
                <motion.li
                  key={job.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-xl2 border border-cream-200 bg-cream-50 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="text-base font-semibold text-ink-900">
                      {job.title || prettyCategory(job.category)}
                    </h3>
                    <span className="rounded-full bg-leaf-100 px-2.5 py-1 text-xs font-semibold text-leaf-700">
                      to collect
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-ink-600">{job.message}</p>

                  {job.pickupAddress && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-400">
                      <MapPin className="size-3.5" aria-hidden="true" />
                      {job.pickupAddress}
                    </p>
                  )}

                  {job.timeline?.length > 0 && (
                    <p className="mt-2 text-xs text-ink-400">
                      {job.timeline[job.timeline.length - 1].summary}
                    </p>
                  )}

                  <Button size="sm" onClick={() => collect(job.donationId)} className="mt-4">
                    <PackageCheck className="size-4" aria-hidden="true" />
                    Mark collected
                  </Button>
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* ----------------------------------------------------------- inbox */}
      {notifications.length > 0 && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Bell className="size-5 text-leaf-600" aria-hidden="true" />
              Recent
            </h2>
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
          </div>

          <ul className="mt-5 space-y-2">
            {notifications.slice(0, 8).map((n) => (
              <li
                key={n.id}
                className={[
                  'rounded-xl border px-4 py-3',
                  n.readAt ? 'border-cream-200 bg-cream-50' : 'border-leaf-200 bg-leaf-50',
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

import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Eye, Gauge, Inbox, Percent, Repeat, Timer } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import ScoreBreakdown from './ScoreBreakdown';
import Badge from './ui/Badge';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import { api } from '../api/client';
import { STATUS_LABEL, STATUS_TONE, prettyCategory } from '../lib/format';

/**
 * The read-only monitoring view.
 *
 * There are no assign or reassign controls here, deliberately. The whole point
 * of the rebuild was removing the human from assignment - an override button
 * would put them straight back, and the first time a donation looked slow
 * somebody would press it. What this view does instead is make the algorithm's
 * reasoning inspectable, so a bad decision can be understood and the scoring
 * changed, rather than worked around one donation at a time.
 */
export default function MonitoringView() {
  const [stats, setStats] = useState(null);
  const [donations, setDonations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api.monitoringStats(),
        api.monitoringDonations(onlyUnmatched ? '?unmatched=true&limit=50' : '?limit=50'),
      ]);
      setStats(s);
      setDonations(d.donations ?? []);
      setError(null);
    } catch (err) {
      setError(
        err.status === 403 ? { message: 'This view requires an admin account.' } : err,
      );
    }
  }, [onlyUnmatched]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function inspect(donationId) {
    if (selected === donationId) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected(donationId);
    setDetail(null);
    try {
      setDetail(await api.monitoringDonation(donationId));
    } catch (err) {
      setError(err);
    }
  }

  const m = stats?.matching;

  const tiles = m
    ? [
        { icon: Timer, value: `${m.avgSecondsToAccept}s`, label: 'average offer → accept' },
        // The single best measure of whether the scoring picks the right
        // agents: how often the FIRST batch of three says yes.
        { icon: Percent, value: `${m.firstRoundMatchRate}%`, label: 'matched on the first offer' },
        { icon: Repeat, value: m.avgOfferRounds, label: 'average rounds' },
        { icon: Gauge, value: m.matched, label: 'donations matched' },
      ]
    : [];

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------ performance */}
      <Card className="p-6 sm:p-8">
        <h2 className="text-xl font-semibold">Matching performance</h2>

        {!m ? (
          <p className="mt-3 text-sm text-ink-500">Nothing matched yet.</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tiles.map(({ icon: Icon, value, label }, i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.06, ease: 'easeOut' }}
                className="rounded-xl2 border border-cream-200 bg-cream-50 p-5"
              >
                <Icon className="size-5 text-leaf-600" aria-hidden="true" />
                <p className="mt-3 font-display text-2xl font-semibold text-ink-900">{value}</p>
                <p className="mt-0.5 text-xs text-ink-500">{label}</p>
              </motion.div>
            ))}
          </div>
        )}

        {stats?.failureReasons?.length > 0 && (
          <p className="mt-5 rounded-xl bg-warm-50 px-4 py-3 text-xs text-warm-800">
            {/* Distinguishing "nobody was online" from "everyone declined" is
                what says whether to recruit agents or revisit the scoring. */}
            <span className="font-semibold">Unmatched: </span>
            {stats.failureReasons
              .map((f) => `${f.count} × ${f.reason.replace(/_/g, ' ').toLowerCase()}`)
              .join(' · ')}
          </p>
        )}
      </Card>

      {error && <ErrorState error={error} onRetry={refresh} />}

      {/* -------------------------------------------------------- donations */}
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Donations</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
            <input
              type="checkbox"
              checked={onlyUnmatched}
              onChange={(e) => setOnlyUnmatched(e.target.checked)}
              className="size-4 rounded border-cream-300 text-leaf-600"
            />
            Only unmatched
          </label>
        </div>

        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-cream-100 px-3 py-1.5 text-xs text-ink-500">
          <Eye className="size-3.5" aria-hidden="true" />
          Read-only — click a donation to see the score breakdown behind its assignment.
        </p>

        <div className="mt-6">
          {donations.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing to show"
              description={
                onlyUnmatched
                  ? 'No unmatched donations — every one found a collector.'
                  : 'No donations have been posted yet.'
              }
            />
          ) : (
            <ul className="space-y-3">
              {donations.map((d) => {
                const open = selected === d.donationId;

                return (
                  <li
                    key={d.donationId}
                    className="overflow-hidden rounded-xl2 border border-cream-200 bg-white"
                  >
                    <button
                      type="button"
                      onClick={() => inspect(d.donationId)}
                      aria-expanded={open}
                      className="flex w-full items-start gap-3 p-5 text-left transition-colors hover:bg-cream-50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink-900">
                            {d.title || prettyCategory(d.category)}
                          </span>
                          <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>
                            {STATUS_LABEL[d.status] ?? d.status.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                        </div>

                        <p className="mt-1.5 text-xs text-ink-400">
                          {d.assignedAgentName ? `${d.assignedAgentName} · ` : ''}
                          {d.offerRounds > 0 &&
                            `${d.offerRounds} round${d.offerRounds === 1 ? '' : 's'} · `}
                          {d.agentsOffered > 0 && `${d.agentsOffered} offered · `}
                          {d.searchRadiusKm && `${d.searchRadiusKm}km · `}
                          {d.secondsToAccept != null && `accepted in ${d.secondsToAccept}s`}
                          {d.lastReason &&
                            !d.assignedAgentName &&
                            d.lastReason.replace(/_/g, ' ').toLowerCase()}
                        </p>
                      </div>

                      <ChevronDown
                        className={`mt-1 size-4 shrink-0 text-ink-400 transition-transform ${
                          open ? 'rotate-180' : ''
                        }`}
                        aria-hidden="true"
                      />
                    </button>

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: 'easeOut' }}
                          className="overflow-hidden border-t border-cream-200 bg-cream-50"
                        >
                          <div className="space-y-5 p-5">
                            {!detail ? (
                              <p className="text-sm text-ink-400">Loading…</p>
                            ) : (
                              <>
                                <div>
                                  <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
                                    Why this agent
                                  </h3>
                                  <div className="mt-3">
                                    <ScoreBreakdown
                                      offers={detail.scoring?.offers}
                                      weights={detail.scoring?.weights}
                                    />
                                  </div>
                                </div>

                                <p className="text-xs text-ink-500">
                                  Searched {detail.donation.searchRadiusKm}km ·{' '}
                                  {detail.donation.candidatesFound} agents found ·{' '}
                                  {detail.donation.candidatesEligible} eligible ·{' '}
                                  {detail.donation.urgency} urgency ·{' '}
                                  {detail.donation.responseTimeoutSeconds}s to respond
                                </p>

                                <div>
                                  <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
                                    What happened
                                  </h3>
                                  <ol className="mt-3 space-y-2.5 border-l-2 border-cream-300 pl-4">
                                    {detail.timeline.map((entry, i) => (
                                      <li key={i} className="relative text-xs">
                                        <span className="absolute left-[-1.32rem] top-1 size-2 rounded-full bg-leaf-400" />
                                        <span className="font-mono text-ink-400">
                                          {new Date(entry.at).toLocaleTimeString()}
                                        </span>{' '}
                                        <span className="text-ink-600">{entry.summary}</span>
                                      </li>
                                    ))}
                                  </ol>
                                </div>

                                {detail.donation.traceId && (
                                  // The one thing an operator most wants next:
                                  // the id that follows this donation through
                                  // every service.
                                  <p className="text-xs text-ink-400">
                                    trace:{' '}
                                    <code className="rounded bg-white px-1.5 py-0.5 font-mono text-ink-600">
                                      {detail.donation.traceId}
                                    </code>
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

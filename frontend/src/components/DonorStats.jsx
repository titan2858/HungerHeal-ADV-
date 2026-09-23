import { motion } from 'framer-motion';
import { Clock, PackageCheck, Timer, Truck } from 'lucide-react';

/**
 * The donor's impact, and how the matching is actually performing.
 *
 * Deliberately shows what was COLLECTED rather than what was posted. Food still
 * sitting in a kitchen has not fed anyone, and a dashboard that counted it
 * would be flattering rather than true.
 */
export default function DonorStats({ summary }) {
  if (!summary) return null;

  const { counts, total, delivered = [], matching } = summary;
  const inProgress = (counts.OFFERED ?? 0) + (counts.ACCEPTED ?? 0);
  const waiting = (counts.PENDING_ASSIGNMENT ?? 0) + (counts.UNASSIGNED ?? 0);

  if (total === 0) return null;

  const tiles = [
    { icon: PackageCheck, value: counts.COLLECTED ?? 0, label: 'donations collected', tone: 'leaf' },
    { icon: Truck, value: inProgress, label: 'in progress', tone: 'leaf' },
    ...(waiting > 0
      ? [{ icon: Clock, value: waiting, label: 'awaiting an agent', tone: 'warm' }]
      : []),
  ];

  return (
    <section className="rounded-xl3 border border-leaf-200 bg-gradient-to-br from-leaf-50 to-cream-50 p-6 sm:p-8">
      <h2 className="text-xl font-semibold">Your impact</h2>

      {delivered.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-8">
          {delivered.map((d, i) => (
            <motion.div
              key={d.unit}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.08, ease: 'easeOut' }}
            >
              <p className="font-display text-4xl font-semibold text-leaf-800">
                {d.amount.toLocaleString()}
              </p>
              <p className="mt-0.5 text-sm text-ink-500">{d.unit.toLowerCase()} collected</p>
            </motion.div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-500">
          Nothing collected yet. Figures appear here once an agent completes a pickup.
        </p>
      )}

      <div className="mt-7 grid gap-3 sm:grid-cols-3">
        {tiles.map(({ icon: Icon, value, label, tone }) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-xl2 bg-white/80 px-4 py-3.5 backdrop-blur"
          >
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                tone === 'warm' ? 'bg-warm-100 text-warm-600' : 'bg-leaf-100 text-leaf-600'
              }`}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span>
              <span className="block font-display text-xl font-semibold text-ink-900">
                {value}
              </span>
              <span className="block text-xs text-ink-500">{label}</span>
            </span>
          </div>
        ))}
      </div>

      {matching && (
        // The automated matching, measured. This is the number that shows the
        // assignment engine working: how long from a donation being offered to
        // an agent saying yes, with no human in between.
        <p className="mt-5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
          <Timer className="size-3.5 text-leaf-600" aria-hidden="true" />
          Agents accepted in{' '}
          <strong className="font-semibold text-ink-700">
            {matching.avgSecondsToAccept}s
          </strong>{' '}
          on average
          {matching.avgOfferRounds > 1.05 && (
            <span>· {matching.avgOfferRounds} offer rounds typically needed</span>
          )}
        </p>
      )}
    </section>
  );
}

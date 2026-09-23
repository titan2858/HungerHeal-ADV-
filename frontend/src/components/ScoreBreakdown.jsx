import { motion } from 'framer-motion';
import { Trophy } from 'lucide-react';

/**
 * Why this agent was chosen, as arithmetic anyone can check.
 *
 * This is the centrepiece of the monitoring view. The old system had an admin
 * who could say "I picked Ravi because he's closest"; the replacement has to be
 * able to answer the same question, and "the algorithm decided" is not an
 * answer when a donation went to the wrong person.
 *
 * Every number here was computed by assignment-engine at decision time and
 * carried on the event. Nothing is recomputed - recomputing would read agent
 * state that has since changed.
 */

// The four terms, in weight order, with what each one is actually measuring.
const TERMS = [
  { key: 'Distance', score: 'distanceScore', weighted: 'weightedDistance', weight: 0.35 },
  { key: 'Category fit', score: 'categoryScore', weighted: 'weightedCategory', weight: 0.25 },
  { key: 'Current load', score: 'loadScore', weighted: 'weightedLoad', weight: 0.2 },
  { key: 'Rating', score: 'ratingScore', weighted: 'weightedRating', weight: 0.15 },
];

export default function ScoreBreakdown({ offers, weights }) {
  if (!offers?.length) {
    return (
      <p className="rounded-xl bg-cream-100 px-4 py-3 text-sm text-ink-500">
        No scoring recorded — this donation was never offered to anyone.
      </p>
    );
  }

  const max = weights?.maxPossibleScore ?? 0.95;

  return (
    <div className="space-y-4">
      {offers.map((offer) => {
        const winner = offer.rank === 1;

        return (
          <div
            key={offer.agentId}
            className={[
              'rounded-xl2 border p-5',
              winner ? 'border-leaf-300 bg-leaf-50' : 'border-cream-200 bg-white',
            ].join(' ')}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                {winner && <Trophy className="size-4 text-warm-600" aria-hidden="true" />}
                <span className="font-mono text-ink-400">#{offer.rank}</span>
                {offer.agentName ?? offer.agentId.slice(0, 8)}
              </h4>
              <p className="font-mono text-sm font-bold text-ink-900">
                {offer.score?.toFixed(4)}
                {/* "0.81" invites "out of what?". The plan's weights sum to
                    0.95, so that is the honest denominator. */}
                <span className="font-normal text-ink-400"> / {max}</span>
              </p>
            </div>

            <table className="mt-4 w-full text-xs">
              <caption className="sr-only">
                Score breakdown for {offer.agentName ?? 'this agent'}
              </caption>
              <tbody>
                {TERMS.map((term) => {
                  const raw = offer.breakdown?.[term.score];
                  const weighted = offer.breakdown?.[term.weighted];
                  if (raw == null) return null;

                  return (
                    <tr key={term.key}>
                      <th scope="row" className="py-1 pr-3 text-left font-medium text-ink-600">
                        {term.key}
                      </th>
                      <td className="w-full py-1 pr-3">
                        {/* The bar is the RAW 0-1 term; the width shows how well
                            the agent did on it, independent of its weight. */}
                        <span className="block h-1.5 overflow-hidden rounded-full bg-cream-200">
                          <motion.span
                            initial={{ width: 0 }}
                            animate={{ width: `${raw * 100}%` }}
                            transition={{ duration: 0.5, ease: 'easeOut' }}
                            className={`block h-full rounded-full ${
                              winner ? 'bg-leaf-500' : 'bg-ink-400'
                            }`}
                          />
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-right font-mono tabular-nums text-ink-700">
                        {raw.toFixed(2)}
                      </td>
                      <td className="py-1 pr-3 text-right font-mono tabular-nums text-ink-400">
                        × {term.weight}
                      </td>
                      <td className="py-1 text-right font-mono font-semibold tabular-nums text-ink-800">
                        {weighted?.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="mt-3 text-xs text-ink-400">
              {offer.breakdown?.distanceKm != null && (
                <>{offer.breakdown.distanceKm.toFixed(2)} km away</>
              )}
              {offer.breakdown?.currentLoad != null && (
                <>
                  {' '}
                  · {offer.breakdown.currentLoad} pending pickup
                  {offer.breakdown.currentLoad === 1 ? '' : 's'}
                </>
              )}
              {offer.breakdown?.rating != null && <> · rated {offer.breakdown.rating}</>}
            </p>
          </div>
        );
      })}
    </div>
  );
}

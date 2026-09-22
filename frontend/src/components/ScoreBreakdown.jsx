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
  { key: 'Current load', score: 'loadScore', weighted: 'weightedLoad', weight: 0.20 },
  { key: 'Rating', score: 'ratingScore', weighted: 'weightedRating', weight: 0.15 },
];

export default function ScoreBreakdown({ offers, weights }) {
  if (!offers?.length) {
    return <p className="hint">No scoring recorded — this donation was never offered to anyone.</p>;
  }

  const max = weights?.maxPossibleScore ?? 0.95;

  return (
    <div className="scoring">
      {offers.map((offer) => (
        <div key={offer.agentId} className={`scored-agent ${offer.rank === 1 ? 'winner' : ''}`}>
          <div className="scored-head">
            <strong>
              #{offer.rank} {offer.agentName ?? offer.agentId.slice(0, 8)}
            </strong>
            <span className="scored-total">
              {offer.score?.toFixed(4)}
              {/* "0.81" invites "out of what?". The plan's weights sum to 0.95,
                  so that is the honest denominator. */}
              <span className="muted"> / {max}</span>
            </span>
          </div>

          <table className="score-table">
            <tbody>
              {TERMS.map((term) => {
                const raw = offer.breakdown?.[term.score];
                const weighted = offer.breakdown?.[term.weighted];
                if (raw == null) return null;

                return (
                  <tr key={term.key}>
                    <td className="term-name">{term.key}</td>
                    <td className="term-bar">
                      {/* The bar is the RAW 0-1 term; the width shows how well
                          the agent did on it, independent of its weight. */}
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${raw * 100}%` }} />
                      </span>
                    </td>
                    <td className="term-raw">{raw.toFixed(2)}</td>
                    <td className="term-weight muted">× {term.weight}</td>
                    <td className="term-weighted">{weighted?.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="muted score-inputs">
            {offer.breakdown?.distanceKm != null && (
              <>{offer.breakdown.distanceKm.toFixed(2)} km away</>
            )}
            {offer.breakdown?.currentLoad != null && (
              <> · {offer.breakdown.currentLoad} pending pickup
                {offer.breakdown.currentLoad === 1 ? '' : 's'}</>
            )}
            {offer.breakdown?.rating != null && <> · rated {offer.breakdown.rating}</>}
          </p>
        </div>
      ))}
    </div>
  );
}

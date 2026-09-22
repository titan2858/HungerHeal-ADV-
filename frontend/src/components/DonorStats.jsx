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

  return (
    <div className="card stats">
      <h2>Your impact</h2>

      {delivered.length > 0 ? (
        <div className="impact">
          {delivered.map((d) => (
            <div key={d.unit} className="impact-figure">
              <span className="impact-value">{d.amount.toLocaleString()}</span>
              <span className="impact-unit">{d.unit.toLowerCase()} collected</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">
          Nothing collected yet. Figures appear here once an agent completes a pickup.
        </p>
      )}

      <div className="stat-grid">
        <div>
          <span className="stat-value">{counts.COLLECTED ?? 0}</span>
          <span className="stat-label">donations collected</span>
        </div>
        <div>
          <span className="stat-value">{inProgress}</span>
          <span className="stat-label">in progress</span>
        </div>
        {waiting > 0 && (
          <div>
            <span className="stat-value warn-value">{waiting}</span>
            <span className="stat-label">awaiting an agent</span>
          </div>
        )}
      </div>

      {matching && (
        // The automated matching, measured. This is the number that shows the
        // assignment engine working: how long from a donation being offered to
        // an agent saying yes, with no human in between.
        <p className="hint matching-note">
          Agents accepted in <strong>{matching.avgSecondsToAccept}s</strong> on average
          {matching.avgOfferRounds > 1.05 && (
            <> · {matching.avgOfferRounds} offer rounds typically needed</>
          )}
        </p>
      )}
    </div>
  );
}

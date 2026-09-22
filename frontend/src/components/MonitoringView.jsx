import { useCallback, useEffect, useState } from 'react';
import ScoreBreakdown from './ScoreBreakdown';
import { api } from '../api/client';

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
      setError(err.status === 403 ? 'This view requires an admin account.' : err.message);
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
      setError(err.message);
    }
  }

  const m = stats?.matching;

  return (
    <>
      <div className="card">
        <h2>Matching performance</h2>

        {!m ? (
          <p className="hint">Nothing matched yet.</p>
        ) : (
          <div className="stat-grid">
            <div>
              <span className="stat-value">{m.avgSecondsToAccept}s</span>
              <span className="stat-label">average offer → accept</span>
            </div>
            <div>
              {/* The single best measure of whether the scoring picks the right
                  agents: how often the FIRST batch of three says yes. */}
              <span className="stat-value">{m.firstRoundMatchRate}%</span>
              <span className="stat-label">matched on the first offer</span>
            </div>
            <div>
              <span className="stat-value">{m.avgOfferRounds}</span>
              <span className="stat-label">average rounds</span>
            </div>
            <div>
              <span className="stat-value">{m.matched}</span>
              <span className="stat-label">donations matched</span>
            </div>
          </div>
        )}

        {stats?.failureReasons?.length > 0 && (
          <p className="hint matching-note">
            {/* Distinguishing "nobody was online" from "everyone declined" is
                what says whether to recruit agents or revisit the scoring. */}
            Unmatched:{' '}
            {stats.failureReasons
              .map((f) => `${f.count} × ${f.reason.replace(/_/g, ' ').toLowerCase()}`)
              .join(' · ')}
          </p>
        )}
      </div>

      {error && <pre className="error">{error}</pre>}

      <div className="card">
        <div className="card-head">
          <h2>Donations</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={onlyUnmatched}
              onChange={(e) => setOnlyUnmatched(e.target.checked)}
            />
            Only unmatched
          </label>
        </div>

        <p className="hint">
          Read-only. Click a donation to see the score breakdown behind its assignment.
        </p>

        {donations.length === 0 ? (
          <p className="hint">Nothing to show.</p>
        ) : (
          <ul className="donations monitoring-list">
            {donations.map((d) => (
              <li key={d.donationId} className={`donation-row status-${d.status.toLowerCase()}`}>
                <button type="button" className="row-button" onClick={() => inspect(d.donationId)}>
                  <div className="donation-head">
                    <strong>{d.title || d.category?.replace(/_/g, ' ').toLowerCase()}</strong>
                    <span className={`status-pill ${d.status.toLowerCase()}`}>
                      {d.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </div>

                  <p className="muted">
                    {d.assignedAgentName ? `${d.assignedAgentName} · ` : ''}
                    {d.offerRounds > 0 && `${d.offerRounds} round${d.offerRounds === 1 ? '' : 's'} · `}
                    {d.agentsOffered > 0 && `${d.agentsOffered} offered · `}
                    {d.searchRadiusKm && `${d.searchRadiusKm}km · `}
                    {d.secondsToAccept != null && `accepted in ${d.secondsToAccept}s`}
                    {d.lastReason && !d.assignedAgentName && d.lastReason.replace(/_/g, ' ').toLowerCase()}
                  </p>
                </button>

                {selected === d.donationId && (
                  <div className="detail">
                    {!detail ? (
                      <p className="hint">Loading…</p>
                    ) : (
                      <>
                        <h3>Why this agent</h3>
                        <ScoreBreakdown
                          offers={detail.scoring?.offers}
                          weights={detail.scoring?.weights}
                        />

                        <p className="muted">
                          Searched {detail.donation.searchRadiusKm}km ·{' '}
                          {detail.donation.candidatesFound} agents found ·{' '}
                          {detail.donation.candidatesEligible} eligible ·{' '}
                          {detail.donation.urgency} urgency ·{' '}
                          {detail.donation.responseTimeoutSeconds}s to respond
                        </p>

                        <h3>What happened</h3>
                        <ul className="timeline">
                          {detail.timeline.map((entry, i) => (
                            <li key={i}>
                              <span className="muted">
                                {new Date(entry.at).toLocaleTimeString()}
                              </span>{' '}
                              {entry.summary}
                            </li>
                          ))}
                        </ul>

                        {detail.donation.traceId && (
                          // The one thing an operator most wants next: the id
                          // that follows this donation through every service.
                          <p className="muted trace">
                            trace: <code>{detail.donation.traceId}</code>
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

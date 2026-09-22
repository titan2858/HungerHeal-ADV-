import { useState } from 'react';

/**
 * One donation in the donor's history.
 *
 * The status pill says where it is; the message says it in words; the history
 * says how it got there. That last one is what a donor actually opens when
 * their food has not been collected.
 */
export default function DonationCard({ tracking }) {
  const [showHistory, setShowHistory] = useState(false);

  const {
    status, message, title, category, quantity, pickupAddress,
    assignedAgentName, assignedAgentPhone, offerRounds, bestBefore,
    collectedAt, timeline = [],
  } = tracking;

  const expiring = bestBefore && status !== 'COLLECTED' && new Date(bestBefore) < Date.now() + 2 * 3600 * 1000;

  return (
    <li className={`donation-row status-${status.toLowerCase()}`}>
      <div className="donation-head">
        <strong>{title || category?.replace(/_/g, ' ').toLowerCase() || 'Donation'}</strong>
        <span className={`status-pill ${status.toLowerCase()}`}>
          {status.replace(/_/g, ' ').toLowerCase()}
        </span>
      </div>

      <p className="donation-message">{message}</p>

      <p className="muted">
        {quantity?.amount != null && (
          <>
            {quantity.amount} {quantity.unit?.toLowerCase()}
            {' · '}
          </>
        )}
        {category?.replace(/_/g, ' ').toLowerCase()}
        {pickupAddress && ` · ${pickupAddress}`}
      </p>

      {assignedAgentName && (
        <p className="agent-line">
          <strong>{assignedAgentName}</strong>
          {/* A name without a number is not actionable when the agent is at
              the wrong gate. */}
          {assignedAgentPhone && (
            <a href={`tel:${assignedAgentPhone.replace(/\s/g, '')}`}> {assignedAgentPhone}</a>
          )}
        </p>
      )}

      {expiring && (
        // Worth surfacing: a donation still waiting with two hours of life left
        // is a different situation from one posted a minute ago.
        <p className="warn">
          Best before {new Date(bestBefore).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {offerRounds > 1 && status !== 'COLLECTED' && (
        // Shows the system is still working rather than stuck. A donation on
        // its third round has been offered to nine agents.
        <p className="muted">Offered to {offerRounds} rounds of agents so far</p>
      )}

      {collectedAt && (
        <p className="muted">Collected {new Date(collectedAt).toLocaleString()}</p>
      )}

      {timeline.length > 0 && (
        <>
          <button type="button" className="link" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : 'History'}
          </button>

          {showHistory && (
            <ul className="timeline">
              {timeline.map((entry, i) => (
                <li key={i}>
                  <span className="muted">
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </span>{' '}
                  {entry.summary}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ChevronDown, MapPin, Phone, Repeat, User } from 'lucide-react';
import { useState } from 'react';
import Badge from './ui/Badge';
import { STATUS_LABEL, STATUS_TONE, clockTime, prettyCategory } from '../lib/format';

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
    <motion.li
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="rounded-xl2 border border-cream-200 bg-white p-5 shadow-soft"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-ink-900">
          {title || prettyCategory(category) || 'Donation'}
        </h3>
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
          {STATUS_LABEL[status] ?? status.replace(/_/g, ' ').toLowerCase()}
        </Badge>
      </div>

      <p className="mt-2 text-sm text-ink-600">{message}</p>

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-400">
        {quantity?.amount != null && (
          <span className="font-medium text-ink-500">
            {quantity.amount} {quantity.unit?.toLowerCase()}
          </span>
        )}
        {quantity?.amount != null && <span aria-hidden="true">·</span>}
        <span>{prettyCategory(category)}</span>
        {pickupAddress && (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" aria-hidden="true" />
              {pickupAddress}
            </span>
          </>
        )}
      </p>

      {assignedAgentName && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-leaf-50 px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-leaf-600 text-white">
            <User className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold text-ink-800">{assignedAgentName}</span>
          {/* A name without a number is not actionable when the agent is at
              the wrong gate. */}
          {assignedAgentPhone && (
            <a
              href={`tel:${assignedAgentPhone.replace(/\s/g, '')}`}
              className="ml-auto inline-flex items-center gap-1.5 text-sm font-semibold text-leaf-700 hover:underline"
            >
              <Phone className="size-3.5" aria-hidden="true" />
              {assignedAgentPhone}
            </a>
          )}
        </div>
      )}

      {expiring && (
        // Worth surfacing: a donation still waiting with two hours of life left
        // is a different situation from one posted a minute ago.
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-warm-100 px-2.5 py-1.5 text-xs font-semibold text-warm-800">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          Best before {clockTime(bestBefore)}
        </p>
      )}

      {offerRounds > 1 && status !== 'COLLECTED' && (
        // Shows the system is still working rather than stuck. A donation on
        // its third round has been offered to nine agents.
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-400">
          <Repeat className="size-3.5" aria-hidden="true" />
          Offered to {offerRounds} rounds of agents so far
        </p>
      )}

      {collectedAt && (
        <p className="mt-3 text-xs text-ink-400">
          Collected {new Date(collectedAt).toLocaleString()}
        </p>
      )}

      {timeline.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-leaf-700 hover:underline"
          >
            {showHistory ? 'Hide history' : 'History'}
            <ChevronDown
              className={`size-3.5 transition-transform ${showHistory ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>

          <AnimatePresence initial={false}>
            {showHistory && (
              <motion.ol
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                className="mt-3 space-y-3 overflow-hidden border-l-2 border-cream-200 pl-4"
              >
                {timeline.map((entry, i) => (
                  <li key={i} className="relative text-xs">
                    <span className="absolute -left-[1.32rem] top-1 size-2 rounded-full bg-leaf-400" />
                    <span className="font-mono text-ink-400">
                      {new Date(entry.at).toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </span>{' '}
                    <span className="text-ink-600">{entry.summary}</span>
                  </li>
                ))}
              </motion.ol>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.li>
  );
}

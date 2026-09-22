import { getClient } from '../config/cassandra.js';

// Writes every event into Cassandra, several times over.
//
// The same event lands in donation_events, events_by_day, and sometimes
// assignment_outcomes and the counter tables. In a relational database that
// would be a normalisation error. In Cassandra it is the design: a table exists
// to answer one query shape, and a second question needs a second table.

export const TOPICS = [
  'donation.created',
  'donation.assigned',
  'donation.accepted',
  'donation.rejected',
  'donation.timeout',
  'donation.unassigned',
  'donation.collected',
];

const dayOf = (date) => date.toISOString().slice(0, 10);

// Which counter column each topic bumps on the daily rollup.
const DAILY_COLUMN = {
  'donation.created': 'created',
  'donation.assigned': 'assigned',
  'donation.accepted': 'accepted',
  'donation.collected': 'collected',
  'donation.unassigned': 'unassigned',
  'donation.timeout': 'timed_out',
};

/**
 * One event, fanned out across the tables that will be asked about it.
 */
export async function recordEvent(eventType, event, { log }) {
  const client = getClient();

  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
  const day = dayOf(occurredAt);
  const eventId = event.eventId ?? `${eventType}-${occurredAt.getTime()}`;

  // The winning agent, where there is one.
  const agentId = event.agentId ?? event.offers?.[0]?.agentId ?? null;
  const agentName = event.agentName ?? event.offers?.[0]?.agentName ?? null;
  const score = event.offers?.[0]?.score ?? null;

  const writes = [
    {
      // The full history of one donation, in order.
      query: `INSERT INTO donation_events
        (donation_id, occurred_at, event_id, event_type, donor_id, agent_id, agent_name,
         category, status, round, score, reason, trace_id, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        event.donationId ?? 'unknown', occurredAt, eventId, eventType,
        event.donorId ?? null, agentId, agentName,
        event.category ?? null, event.status ?? null,
        event.round ?? null, score, event.reason ?? null,
        event.traceId ?? null,
        // The raw event, kept whole. Columns answer today's questions; the
        // payload is what makes tomorrow's answerable without a migration -
        // the point of keeping history at all.
        JSON.stringify(event),
      ],
    },
    {
      // The same event, keyed for "what happened on this day?".
      query: `INSERT INTO events_by_day
        (day, occurred_at, event_id, donation_id, event_type, category, agent_id, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        day, occurredAt, eventId, event.donationId ?? 'unknown',
        eventType, event.category ?? null, agentId, score,
      ],
    },
  ];

  // Counters cannot be mixed with normal columns in one statement, so the
  // rollup is its own write.
  const dailyColumn = DAILY_COLUMN[eventType];
  if (dailyColumn) {
    writes.push({
      query: `UPDATE daily_totals SET ${dailyColumn} = ${dailyColumn} + 1 WHERE day = ?`,
      params: [day],
    });
  }

  // Per-agent counters.
  if (eventType === 'donation.assigned') {
    for (const offer of event.offers ?? []) {
      writes.push({
        query: 'UPDATE agent_totals SET offered = offered + 1 WHERE agent_id = ?',
        params: [offer.agentId],
      });
    }
  }
  if (eventType === 'donation.accepted' && agentId) {
    writes.push({
      query: 'UPDATE agent_totals SET accepted = accepted + 1 WHERE agent_id = ?',
      params: [agentId],
    });
  }
  if (eventType === 'donation.rejected' && event.agentId) {
    writes.push({
      query: 'UPDATE agent_totals SET declined = declined + 1 WHERE agent_id = ?',
      params: [event.agentId],
    });
  }
  if (eventType === 'donation.collected' && agentId) {
    writes.push({
      query: 'UPDATE agent_totals SET collected = collected + 1 WHERE agent_id = ?',
      params: [agentId],
    });
  }
  if (eventType === 'donation.timeout') {
    for (const id of event.offeredTo ?? []) {
      writes.push({
        query: 'UPDATE agent_totals SET timed_out = timed_out + 1 WHERE agent_id = ?',
        params: [id],
      });
    }
  }

  // One row per completed match, so time-to-accept needs no arithmetic on read.
  if (eventType === 'donation.accepted') {
    writes.push({
      query: `INSERT INTO assignment_outcomes
        (day, occurred_at, donation_id, agent_id, agent_name, category, urgency,
         seconds_to_accept, offer_rounds, score, search_radius_km)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        day, occurredAt, event.donationId ?? 'unknown', agentId, agentName,
        event.category ?? null, event.urgency ?? null,
        event.responseSeconds ?? null, event.round ?? null,
        score, event.searchRadiusKm ?? null,
      ],
    });
  }

  // Not a batch. Cassandra's BATCH is for atomicity within ONE partition, and
  // these writes span several partitions and several tables - a multi-partition
  // batch makes the coordinator do more work and is a well-known anti-pattern.
  // Independent writes are the correct shape here, and a partial failure is
  // acceptable for analytics in a way it would not be for a donation.
  await Promise.all(writes.map((w) => client.execute(w.query, w.params, { prepare: true })));

  log.debug({ donationId: event.donationId, eventType, writes: writes.length }, 'event recorded');
}

export function buildHandlers() {
  return Object.fromEntries(
    TOPICS.map((topic) => [topic, (event, ctx) => recordEvent(topic, event, ctx)]),
  );
}

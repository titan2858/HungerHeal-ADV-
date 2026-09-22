import { DonationStatus } from '../models/DonationStatus.js';
import { STATUS, applyEvent, DONOR_MESSAGE } from '../domain/statusMachine.js';

// Turns events into status changes and timeline entries.
//
// Every handler funnels through recordEvent, so the state machine is consulted
// exactly once per event and there is a single place where "what does this
// event mean?" is answered.

export const TOPICS = [
  'donation.created',
  'donation.assigned',
  'donation.accepted',
  'donation.rejected',
  'donation.timeout',
  'donation.unassigned',
  'donation.collected',
];

/**
 * Applies one event to a donation's record.
 *
 * @param event      the raw event
 * @param eventType  the topic it arrived on
 * @param summary    human-readable, written now rather than regenerated later
 * @param patch      extra fields to set when the status actually changes
 */
async function recordEvent(event, { eventType, summary, patch = {}, log }) {
  const { donationId } = event;
  if (!donationId) {
    log.warn({ eventType }, 'event has no donationId; ignoring');
    return null;
  }

  // Created on first sight rather than requiring donation.created to arrive
  // first. Topics are separate partitions with no ordering guarantee between
  // them, so donation.assigned can genuinely land before donation.created.
  let record = await DonationStatus.findOne({ donationId });
  if (!record) {
    record = new DonationStatus({
      donationId,
      donorId: event.donorId ?? 'unknown',
      category: event.category ?? null,
      status: STATUS.PENDING_ASSIGNMENT,
      traceId: event.traceId ?? null,
    });
  }

  const previous = record.status;
  const { nextStatus, changed, reason } = applyEvent(previous, eventType);

  // The timeline records EVERY event, including ones that changed nothing.
  // "Three agents were offered this and all declined" is exactly the history a
  // donor asking why their food is still here needs to see, and a
  // status-changes-only log would throw it away.
  record.timeline.push({
    at: event.occurredAt ? new Date(event.occurredAt) : new Date(),
    eventType,
    fromStatus: previous,
    toStatus: changed ? nextStatus : null,
    summary,
    agentId: patch.assignedAgentId ?? event.agentId ?? null,
    agentName: patch.assignedAgentName ?? event.agentName ?? null,
    round: event.round ?? null,
    reason: changed ? null : reason,
    eventId: event.eventId ?? 'unknown',
    traceId: event.traceId ?? null,
  });

  record.lastEventAt = new Date();

  if (changed) {
    record.status = nextStatus;
    Object.assign(record, patch);
  } else if (reason === 'ILLEGAL_TRANSITION' || reason === 'ALREADY_TERMINAL') {
    // Worth a warning rather than silence: it is usually an out-of-order
    // delivery, which is expected, but a flood of them would mean something is
    // genuinely wrong with the event flow.
    log.warn(
      { donationId, eventType, from: previous, attempted: nextStatus, reason },
      'event did not change the status',
    );
  }

  await record.save();

  if (changed) {
    log.info({ donationId, from: previous, to: nextStatus, eventType }, 'donation status changed');
  }

  return record;
}

export function buildHandlers() {
  return {
    'donation.created': (event, { log }) =>
      recordEvent(event, {
        eventType: 'donation.created',
        summary: `Donation received: ${event.category ?? 'food'} at ${event.pickup?.address ?? 'an address'}`,
        log,
      }),

    'donation.assigned': async (event, { log }) => {
      const names = (event.offers ?? []).map((o) => o.agentName).filter(Boolean);
      const round = event.round ?? 1;

      const record = await recordEvent(event, {
        eventType: 'donation.assigned',
        summary:
          round > 1
            ? `Re-offered to ${names.length} agent(s) after round ${round - 1} went unanswered: ${names.join(', ')}`
            : `Offered to ${names.length} nearby agent(s): ${names.join(', ')}`,
        patch: {},
        log,
      });

      if (record) {
        // Counted outside the state machine because they are facts about the
        // offer, not about the status: a donation offered four times is still
        // just OFFERED, but the difference matters to anyone reading it.
        record.offerRounds = Math.max(record.offerRounds, round);
        record.agentsOffered = (event.offers ?? []).length;
        if (!record.firstOfferedAt) record.firstOfferedAt = new Date();
        await record.save();
      }
      return record;
    },

    'donation.accepted': (event, { log }) =>
      recordEvent(event, {
        eventType: 'donation.accepted',
        summary: `${event.agentName ?? 'An agent'} accepted and is on the way`,
        patch: {
          assignedAgentId: event.agentId ?? null,
          assignedAgentName: event.agentName ?? null,
          assignedAgentPhone: event.agentPhone ?? null,
          acceptedAt: new Date(),
        },
        log,
      }),

    'donation.rejected': (event, { log }) =>
      recordEvent(event, {
        eventType: 'donation.rejected',
        summary: `An agent declined${event.reason ? `: ${event.reason}` : ''}. ${
          event.remainingInBatch ?? 0
        } still deciding`,
        log,
      }),

    'donation.timeout': (event, { log }) =>
      recordEvent(event, {
        eventType: 'donation.timeout',
        summary: `Round ${event.round ?? 1} went unanswered by ${
          (event.offeredTo ?? []).length
        } agent(s); finding others`,
        log,
      }),

    'donation.unassigned': async (event, { log }) => {
      const record = await recordEvent(event, {
        eventType: 'donation.unassigned',
        summary: event.message ?? 'No agent could be found',
        log,
      });
      if (record) {
        // Kept so the donor-facing view can explain WHY, not just that it
        // failed - "nobody is online nearby" and "everyone declined" call for
        // different responses from the donor.
        record.lastReason = event.reason ?? null;
        await record.save();
      }
      return record;
    },

    'donation.collected': (event, { log }) =>
      recordEvent(event, {
        eventType: 'donation.collected',
        summary: `Collected by ${event.agentName ?? 'the agent'}`,
        patch: { collectedAt: new Date() },
        log,
      }),
  };
}

// Shapes a record for the donor, who wants a sentence rather than an enum.
export function toDonorView(record) {
  const json = record.toJSON();
  return {
    ...json,
    message: DONOR_MESSAGE[record.status] ?? record.status,
  };
}

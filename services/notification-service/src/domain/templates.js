// Turns an event into the notifications it should produce.
//
// PURE: no Mongo, no Kafka, no clock. One event can produce several
// notifications (an offer goes to three agents at once), or none at all, and
// deciding which is a rule worth unit-testing on its own.

export const RECIPIENT = Object.freeze({ DONOR: 'DONOR', AGENT: 'AGENT' });

export const KIND = Object.freeze({
  OFFER: 'OFFER',                   // an agent is asked to collect - time-sensitive
  OFFER_CLOSED: 'OFFER_CLOSED',     // the offer went to someone else
  DONATION_UPDATE: 'DONATION_UPDATE', // progress for the donor
  ACTION_NEEDED: 'ACTION_NEEDED',   // the donor has to do something
});

// Drives ordering and, later, whether a push is worth waking someone for.
export const PRIORITY = Object.freeze({ HIGH: 'HIGH', NORMAL: 'NORMAL', LOW: 'LOW' });

/**
 * @returns array of notifications to create - possibly empty.
 */
export function notificationsFor(eventType, event) {
  switch (eventType) {
    // ---------------------------------------------------------------- offers
    case 'donation.assigned': {
      const offers = event.offers ?? [];
      const timeout = event.responseTimeoutSeconds ?? 90;

      // One notification PER offered agent. This is the parallel offer made
      // visible: three agents are each told at the same moment, and the first
      // to accept wins.
      return offers.map((offer) => ({
        recipientId: offer.agentId,
        recipientRole: RECIPIENT.AGENT,
        kind: KIND.OFFER,
        priority: PRIORITY.HIGH,
        title: `Collection request: ${readable(event.category)}`,
        body:
          `${event.pickup?.address ?? 'A pickup'} — respond within ${timeout} seconds. ` +
          `You are ranked #${offer.rank} of ${offers.length}.`,
        donationId: event.donationId,
        // The app needs this to show a countdown rather than a static message.
        expiresInSeconds: timeout,
        meta: { rank: offer.rank, score: offer.score, round: event.round ?? 1 },
      }));
    }

    // ------------------------------------------------------------- acceptance
    case 'donation.accepted': {
      const notifications = [
        {
          recipientId: event.donorId,
          recipientRole: RECIPIENT.DONOR,
          kind: KIND.DONATION_UPDATE,
          priority: PRIORITY.HIGH,
          title: 'An agent is on the way',
          // The donor wants a name and a number, not a status code.
          body: `${event.agentName ?? 'An agent'} accepted your donation${
            event.agentPhone ? ` — ${event.agentPhone}` : ''
          }.`,
          donationId: event.donationId,
          meta: { agentId: event.agentId, responseSeconds: event.responseSeconds },
        },
      ];

      if (event.agentId) {
        notifications.push({
          recipientId: event.agentId,
          recipientRole: RECIPIENT.AGENT,
          kind: KIND.DONATION_UPDATE,
          priority: PRIORITY.NORMAL,
          title: 'Pickup confirmed',
          body: 'This donation is yours. Collect it and mark it collected when done.',
          donationId: event.donationId,
        });
      }

      return notifications;
    }

    // ------------------------------------------------------------- collection
    case 'donation.collected':
      return [
        {
          recipientId: event.donorId,
          recipientRole: RECIPIENT.DONOR,
          kind: KIND.DONATION_UPDATE,
          priority: PRIORITY.NORMAL,
          title: 'Collected',
          body: `${event.agentName ?? 'The agent'} has collected your donation. Thank you.`,
          donationId: event.donationId,
        },
      ];

    // ------------------------------------------------------------- nobody found
    case 'donation.unassigned': {
      // The reason changes what the donor can usefully DO, so the message
      // changes with it rather than saying "something went wrong" four ways.
      const byReason = {
        NOT_GEOCODED: {
          title: 'We could not find that address',
          body: 'Your donation is saved, but the pickup address did not resolve. Set the location on the map so an agent can be sent.',
          kind: KIND.ACTION_NEEDED,
          priority: PRIORITY.HIGH,
        },
        NO_AGENTS_FOUND: {
          title: 'No agent available yet',
          body: 'Nobody is nearby right now. We will keep trying as agents come online.',
          kind: KIND.DONATION_UPDATE,
          priority: PRIORITY.NORMAL,
        },
        NO_ELIGIBLE_AGENTS: {
          title: 'No suitable agent nearby',
          body: 'Agents are nearby but none can carry this type of food right now. We will keep trying.',
          kind: KIND.DONATION_UPDATE,
          priority: PRIORITY.NORMAL,
        },
        ALL_AGENTS_EXHAUSTED: {
          title: 'Nobody has accepted this yet',
          body: 'Every nearby agent has been asked and none could take it. It is still listed, and we will retry.',
          kind: KIND.ACTION_NEEDED,
          priority: PRIORITY.HIGH,
        },
      };

      const template = byReason[event.reason] ?? byReason.NO_AGENTS_FOUND;

      return [
        {
          recipientId: event.donorId,
          recipientRole: RECIPIENT.DONOR,
          ...template,
          donationId: event.donationId,
          meta: { reason: event.reason, retryable: event.retryable },
        },
      ];
    }

    // ---------------------------------------------------------------- declines
    case 'donation.rejected':
      // Deliberately nothing. A donor does not need to know that one of three
      // agents said no - the others are still deciding, and a notification per
      // decline would be noise that teaches them to ignore notifications.
      return [];

    case 'donation.timeout':
      // Same reasoning: the engine is already re-offering. Telling the donor
      // about each lapsed round would be alarming and useless.
      return [];

    default:
      return [];
  }
}

// Closes the offer for the agents who did not win, so their app can stop
// showing a countdown for a donation somebody else is already collecting.
export function offerClosedFor(agentIds, event) {
  return agentIds.map((agentId) => ({
    recipientId: agentId,
    recipientRole: RECIPIENT.AGENT,
    kind: KIND.OFFER_CLOSED,
    priority: PRIORITY.LOW,
    title: 'Collection request closed',
    body: 'Another agent accepted this one first.',
    donationId: event.donationId,
  }));
}

function readable(category) {
  if (!category) return 'food';
  return category.toLowerCase().replace(/_/g, ' ');
}

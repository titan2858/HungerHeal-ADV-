import { Notification } from '../models/Notification.js';
import { notificationsFor, offerClosedFor } from '../domain/templates.js';

export const TOPICS = [
  'donation.assigned',
  'donation.accepted',
  'donation.rejected',
  'donation.timeout',
  'donation.unassigned',
  'donation.collected',
];

async function createAll(notifications, event, log) {
  if (notifications.length === 0) return 0;

  const docs = notifications.map((n) => ({
    ...n,
    sourceEventId: event.eventId ?? null,
    traceId: event.traceId ?? null,
    expiresAt: n.expiresInSeconds
      ? new Date(Date.now() + n.expiresInSeconds * 1000)
      : null,
  }));
  for (const d of docs) delete d.expiresInSeconds;

  try {
    // ordered:false so one duplicate does not abort the rest of the batch -
    // if two of three agents are new and one is a redelivery, the two new ones
    // must still be notified.
    await Notification.insertMany(docs, { ordered: false });
    return docs.length;
  } catch (err) {
    // Code 11000 is the unique index rejecting a duplicate, which is the index
    // doing its job rather than a failure.
    if (err.code === 11000 || err.writeErrors) {
      const inserted = err.result?.nInserted ?? 0;
      log.debug({ attempted: docs.length, inserted }, 'some notifications were duplicates');
      return inserted;
    }
    throw err;
  }
}

export function buildHandlers() {
  const forTopic = (topic) => async (event, { log }) => {
    const created = await createAll(notificationsFor(topic, event), event, log);
    if (created > 0) {
      // `topic` is already bound on this logger by the consumer. Repeating it
      // here would emit the key twice in one JSON line, and log processors are
      // free to drop or reorder duplicates.
      log.info({ donationId: event.donationId, created }, 'notifications created');
    }
  };

  return {
    'donation.assigned': forTopic('donation.assigned'),
    'donation.collected': forTopic('donation.collected'),
    'donation.unassigned': forTopic('donation.unassigned'),
    'donation.rejected': forTopic('donation.rejected'),
    'donation.timeout': forTopic('donation.timeout'),

    'donation.accepted': async (event, { log }) => {
      await createAll(notificationsFor('donation.accepted', event), event, log);

      // Close the open OFFER for everyone who did not win, so their app stops
      // counting down a request somebody else already took. Without this an
      // agent taps Accept, gets a 409, and reasonably concludes the app is
      // broken.
      const losers = await Notification.find({
        donationId: event.donationId,
        kind: 'OFFER',
        recipientId: { $ne: event.agentId },
      }).select('recipientId');

      const loserIds = [...new Set(losers.map((n) => n.recipientId))];
      if (loserIds.length > 0) {
        await createAll(offerClosedFor(loserIds, event), { ...event, eventId: `${event.eventId}:closed` }, log);

        // The stale offers themselves are marked read: they are no longer
        // actionable, and leaving them unread would keep a badge lit for
        // something the agent can do nothing about.
        await Notification.updateMany(
          { donationId: event.donationId, kind: 'OFFER', recipientId: { $in: loserIds }, readAt: null },
          { $set: { readAt: new Date() } },
        );
        log.info({ donationId: event.donationId, closed: loserIds.length }, 'closed losing offers');
      }
    },
  };
}

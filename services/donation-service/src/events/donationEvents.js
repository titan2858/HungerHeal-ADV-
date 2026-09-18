import { randomUUID } from 'node:crypto';
import { publish } from '../config/kafka.js';
import { logger } from '../utils/logger.js';

export const TOPIC_DONATION_CREATED = 'donation.created';

// The event envelope every HungerHeal event shares.
//
// `eventId` is the important field: Kafka delivers AT LEAST once, so a consumer
// that crashes after doing its work but before committing its offset will see
// this exact message again. Consumers therefore SETNX on eventId in Redis
// (Phase 6) and skip anything they have already handled. Without a stable
// per-event id there is nothing to deduplicate on.
export function buildDonationCreatedEvent(donation) {
  return {
    eventId: randomUUID(),
    eventType: TOPIC_DONATION_CREATED,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: donation.traceId,

    donationId: donation.id ?? donation._id.toString(),
    donorId: donation.donorId,

    // Everything assignment-engine needs to score candidates, carried IN the
    // event rather than fetched afterwards. If the engine had to call back into
    // donation-service to enrich each event, the two services would be coupled
    // again and a donation-service outage would stall matching entirely.
    category: donation.category,
    quantity: donation.quantity,
    bestBefore: donation.bestBefore,

    pickup: {
      address: donation.pickupAddress,
      // null until Phase 3's geocoding-service resolves the address.
      // assignment-engine cannot run a radius search without these.
      lng: donation.location?.coordinates?.[0] ?? null,
      lat: donation.location?.coordinates?.[1] ?? null,
    },
  };
}

// Publishes and reports success as a boolean rather than throwing: the caller
// has already saved the donation, and a Kafka hiccup must not turn a successful
// donation into an HTTP error for the donor.
export async function publishDonationCreated(donation, log = logger) {
  const event = buildDonationCreatedEvent(donation);
  const donationId = event.donationId;

  try {
    const result = await publish({
      topic: TOPIC_DONATION_CREATED,
      key: donationId, // same partition for every event about this donation
      value: event,
      headers: {
        'x-trace-id': event.traceId ?? '',
        'x-event-id': event.eventId,
      },
    });

    // publish() returns { skipped: true } when KAFKA_ENABLED is false. Nothing
    // reached a broker, so reporting success here would mark the donation as
    // announced when it never was - and the outbox would never retry it.
    if (result?.skipped) {
      log.warn({ donationId }, 'kafka disabled - donation.created not published');
      return false;
    }

    log.info({ donationId, eventId: event.eventId }, 'published donation.created');
    return true;
  } catch (err) {
    // Loud, because the donation now exists but nothing downstream knows.
    // The outbox sweeper is what actually fixes it.
    log.error(
      { donationId, err: err.message },
      'failed to publish donation.created - left for the outbox sweeper',
    );
    return false;
  }
}

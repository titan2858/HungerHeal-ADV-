import { Donation } from '../models/Donation.js';
import { publishDonationCreated } from './donationEvents.js';
import { isKafkaConnected } from '../config/kafka.js';
import { env } from '../config/env.js';
import { childLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// THE DUAL-WRITE PROBLEM, and why this file exists.
//
// Creating a donation means two writes to two different systems: save to Mongo,
// then publish to Kafka. There is no transaction spanning both, so the process
// can die in between - leaving a donation that exists but that assignment-engine
// will never hear about. The donor sees a successful submission and their food
// is never collected. Silent, and the worst possible failure for this product.
//
// The standard fix is the transactional outbox: write the event into the same
// database, in the same transaction as the entity, then relay it to the broker
// separately. This is a light version of that - the donation row carries its own
// `eventPublished` flag instead of a separate outbox collection - which fits
// because there is exactly one event per donation at creation.
//
// The ordering that makes it safe:
//   1. save the donation with eventPublished = false   <- durable first
//   2. try to publish
//   3. on success set eventPublished = true
// A crash at any point leaves a donation that this sweeper will find and retry.
// The cost is that an event may be published twice (if the crash lands between
// 2 and 3), which is exactly why consumers deduplicate on eventId.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 20;
let timer = null;

export async function sweepOutbox() {
  // Pointless to try while the broker is unreachable; the next tick will pick
  // these up once it is back.
  if (!env.KAFKA_ENABLED || !isKafkaConnected()) return { swept: 0, published: 0 };

  const pending = await Donation.find({
    eventPublished: false,
    eventPublishAttempts: { $lt: MAX_ATTEMPTS },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  let published = 0;

  for (const donation of pending) {
    // Reuses the donation's ORIGINAL traceId, so a retry three minutes later
    // still shows up under the same trace as the request that created it.
    const log = childLogger({ traceId: donation.traceId, retry: true });

    const ok = await publishDonationCreated(donation, log);
    donation.eventPublishAttempts += 1;
    if (ok) {
      donation.eventPublished = true;
      published += 1;
    }
    await donation.save();
  }

  if (pending.length > 0) {
    childLogger({ component: 'outbox' }).info(
      { pending: pending.length, published },
      'outbox sweep completed',
    );
  }

  return { swept: pending.length, published };
}

export function startOutboxSweeper() {
  if (!env.KAFKA_ENABLED) return;

  timer = setInterval(() => {
    sweepOutbox().catch((err) =>
      childLogger({ component: 'outbox' }).error({ err: err.message }, 'outbox sweep failed'),
    );
  }, env.OUTBOX_SWEEP_INTERVAL_MS);

  // Do not hold the process open just for this timer during shutdown.
  timer.unref();
}

export function stopOutboxSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

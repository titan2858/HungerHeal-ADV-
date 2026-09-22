import { Kafka, logLevel } from 'kafkajs';
import { env, kafkaBrokers } from '../config/env.js';
import { getRedis, isRedisReady } from '../config/redis.js';
import { logger, childLogger } from '../utils/logger.js';

// The Node counterpart of assignment-engine's consume loop. Same three ideas,
// and they are worth restating because they are what makes an event-driven
// system trustworthy rather than merely asynchronous:
//
//   1. process, THEN commit - a crash redelivers instead of losing the event
//   2. deduplicate on eventId  - because of 1, the same event WILL arrive twice
//   3. a failure does not commit - so it is retried rather than swallowed

let kafka = null;
let consumer = null;
let connected = false;

export const isKafkaConnected = () => connected;

/**
 * @param topics   which topics to subscribe to
 * @param handlers { [eventType]: async (event, ctx) => void }
 */
export async function startConsumer(topics, handlers) {
  if (!env.KAFKA_ENABLED) {
    logger.warn('KAFKA_ENABLED=false - no events will be consumed');
    return null;
  }

  kafka = new Kafka({
    clientId: env.KAFKA_CLIENT_ID,
    brokers: kafkaBrokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  });

  consumer = kafka.consumer({
    // Its own group, so analytics-service receives EVERY event rather than
    // splitting them with assignment-engine. Two different groups reading one
    // topic each get the full stream - which is exactly what makes adding a
    // new consumer free.
    groupId: env.KAFKA_CONSUMER_GROUP,
    // Give a slow Mongo write room before the broker assumes this consumer is
    // dead and rebalances the partition away mid-work.
    sessionTimeout: 30000,
  });

  consumer.on(consumer.events.CONNECT, () => { connected = true; });
  consumer.on(consumer.events.DISCONNECT, () => { connected = false; });

  await consumer.connect();

  for (const topic of topics) {
    // fromBeginning so a newly deployed analytics-service reconstructs the
    // history of donations that were created before it existed, rather than
    // starting blind with donations it has no record of.
    await consumer.subscribe({ topic, fromBeginning: true });
  }

  await consumer.run({
    // One message at a time. This service does small Mongo writes, and the
    // ordering per donation matters more than throughput.
    eachMessage: async ({ topic, message }) => {
      await handleMessage(topic, message, handlers);
    },
  });

  logger.info({ topics, groupId: env.KAFKA_CONSUMER_GROUP }, 'kafka consumer running');
  return consumer;
}

async function handleMessage(topic, message, handlers) {
  let event;
  try {
    event = JSON.parse(message.value.toString());
  } catch (err) {
    // A message that cannot be parsed will never parse. kafkajs commits
    // automatically after eachMessage returns, so returning here skips it -
    // the alternative is throwing forever and blocking the partition.
    logger.error({ topic, err: err.message }, 'discarding unparseable message');
    return;
  }

  // Read from the BODY, not the header. Headers do not survive every path a
  // message can take into a topic (a replay, a mirroring tool), and losing the
  // id would silently disable deduplication.
  const eventId = event.eventId ?? message.headers?.['x-event-id']?.toString();
  const traceId = event.traceId ?? message.headers?.['x-trace-id']?.toString();
  const log = childLogger({ traceId, topic });

  const handler = handlers[topic];
  if (!handler) {
    log.warn({ topic }, 'no handler registered for this topic');
    return;
  }

  // ------------------------------------------------------- idempotency
  const fresh = await beginProcessing(eventId);
  if (!fresh) {
    log.debug({ eventId }, 'event already processed, skipping');
    return;
  }

  try {
    await handler(event, { log, traceId, topic });
  } catch (err) {
    // Release the marker so the redelivery actually retries. The marker is set
    // BEFORE the work, so leaving it in place after a failure would make the
    // retry skip an event that was never successfully applied.
    await abandonProcessing(eventId);

    log.error({ err: err.message, eventId, topic }, 'failed to handle event');
    // Rethrown so kafkajs does not commit the offset; the message is
    // redelivered rather than quietly lost.
    throw err;
  }
}

async function beginProcessing(eventId) {
  if (!eventId) return true; // nothing to deduplicate on; processing is safer than skipping
  if (!isRedisReady()) return true; // a dedup outage must not stop the pipeline

  try {
    const key = `processed:analytics:${eventId}`;
    // Namespaced per service: assignment-engine and analytics-service both
    // process the same events and must each get their own turn. A shared key
    // would mean whichever consumed first silently suppressed the other.
    const set = await getRedis().set(key, '1', 'EX', env.DEDUP_TTL_SECONDS, 'NX');
    return set === 'OK';
  } catch (err) {
    logger.warn({ err: err.message }, 'dedup check failed; processing anyway');
    return true;
  }
}

async function abandonProcessing(eventId) {
  if (!eventId || !isRedisReady()) return;
  try {
    await getRedis().del(`processed:analytics:${eventId}`);
  } catch {
    /* best effort - the TTL will clear it eventually */
  }
}

export async function stopConsumer() {
  if (consumer) {
    await consumer.disconnect();
    connected = false;
  }
}

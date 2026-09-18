import { Kafka, logLevel } from 'kafkajs';
import { env, kafkaBrokers } from './env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// The Kafka producer: this service's only way of telling the rest of the system
// that a donation exists.
//
// donation-service never calls assignment-engine. It appends a fact -
// "donation.created" - to a log, and is done. Whoever cares reads it. If
// assignment-engine is restarting, the event waits in the topic and is picked up
// when it returns. Nothing is lost, and this service does not even need to know
// assignment-engine exists.
// ---------------------------------------------------------------------------

let kafka = null;
let producer = null;
let connected = false;

export function isKafkaConnected() {
  return connected;
}

export async function connectProducer() {
  if (!env.KAFKA_ENABLED) {
    logger.warn('KAFKA_ENABLED=false - events will not be published');
    return null;
  }

  kafka = new Kafka({
    clientId: env.KAFKA_CLIENT_ID,
    brokers: kafkaBrokers,
    // kafkajs is chatty at INFO; its warnings are the part worth seeing.
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  });

  producer = kafka.producer({
    // An idempotent producer tags each message with a sequence number, so a
    // retry after a network blip cannot append the same message twice. Without
    // it, "did my write land?" is unanswerable: retrying risks a duplicate,
    // not retrying risks losing the donation.
    //
    // Setting this also forces acks=all - the broker only acknowledges once the
    // message is durably written - which is the guarantee we actually want.
    idempotent: true,
  });

  producer.on(producer.events.DISCONNECT, () => {
    connected = false;
    logger.warn('kafka producer disconnected');
  });
  producer.on(producer.events.CONNECT, () => {
    connected = true;
    logger.info({ brokers: kafkaBrokers }, 'kafka producer connected');
  });

  await producer.connect();
  connected = true;
  return producer;
}

export async function disconnectProducer() {
  if (producer) {
    await producer.disconnect();
    connected = false;
  }
}

// Throws if Kafka is unreachable. Callers decide what that means - for a
// donation it means "saved, but not yet announced", never "rejected".
export async function publish({ topic, key, value, headers = {} }) {
  if (!env.KAFKA_ENABLED) return { skipped: true };
  if (!producer) throw new Error('kafka producer is not initialised');

  return producer.send({
    topic,
    messages: [
      {
        // THE KEY IS NOT DECORATION. Kafka routes by key hash, so every event
        // sharing a donationId lands on the same partition, and ordering is
        // guaranteed within a partition. That is what stops donation.accepted
        // from being processed before donation.assigned for the same donation.
        key,
        value: JSON.stringify(value),
        headers,
      },
    ],
  });
}

import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { env, kafkaBrokers } from '../config/env.js';
import { logger } from '../utils/logger.js';

// tracking-service publishes exactly one event: donation.collected, when an
// agent marks a pickup done. Everything else it does is react to other
// services' events.

let producer = null;
let connected = false;

export const isProducerConnected = () => connected;

export async function connectProducer() {
  if (!env.KAFKA_ENABLED) return null;

  const kafka = new Kafka({
    clientId: `${env.KAFKA_CLIENT_ID}-producer`,
    brokers: kafkaBrokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  });

  // Idempotent, so a retry after a network blip cannot append the same
  // collection twice - which would decrement an agent's load counter twice and
  // make them look more available than they are.
  producer = kafka.producer({ idempotent: true });

  producer.on(producer.events.CONNECT, () => { connected = true; });
  producer.on(producer.events.DISCONNECT, () => { connected = false; });

  await producer.connect();
  connected = true;
  return producer;
}

export async function publishCollected({ donationId, donorId, category, agentId, agentName, traceId }) {
  const event = {
    eventId: randomUUID(),
    eventType: 'donation.collected',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId,
    donationId,
    donorId,
    category,
    agentId,
    agentName,
  };

  if (!env.KAFKA_ENABLED || !producer) {
    logger.warn({ donationId }, 'kafka disabled - donation.collected not published');
    return { published: false, event };
  }

  await producer.send({
    topic: 'donation.collected',
    // Keyed by donationId, like every other event about this donation, so it
    // lands on the same partition and is processed in order.
    messages: [{
      key: donationId,
      value: JSON.stringify(event),
      headers: { 'x-trace-id': traceId ?? '', 'x-event-id': event.eventId },
    }],
  });

  return { published: true, event };
}

export async function disconnectProducer() {
  if (producer) { await producer.disconnect(); connected = false; }
}

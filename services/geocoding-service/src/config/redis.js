import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// This is HungerHeal's first real use of Redis. It is used here as a CACHE:
// a store of answers that are expensive to compute again, kept in RAM so a
// lookup costs microseconds instead of a network round trip to OpenCage.
//
// Redis appears three more times later - agent geolocation (GEOSEARCH),
// per-agent load counters, and Kafka event deduplication - but caching is the
// easiest place to see why an in-memory store earns its keep.

let redis = null;
let ready = false;

export function getRedis() {
  if (!redis) throw new Error('redis is not initialised');
  return redis;
}

export function isRedisReady() {
  return ready;
}

export async function connectRedis() {
  redis = new Redis(env.REDIS_URL, {
    // Do not queue commands forever while Redis is unreachable - fail the
    // command so the caller can fall back to calling the provider directly.
    // A cache outage must degrade performance, never correctness.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    lazyConnect: true,
  });

  redis.on('ready', () => {
    ready = true;
    logger.info({ url: env.REDIS_URL.replace(/:[^:@]*@/, ':***@') }, 'redis connected');
  });
  redis.on('error', (err) => {
    ready = false;
    logger.warn({ err: err.message }, 'redis error - falling back to uncached lookups');
  });
  redis.on('close', () => {
    ready = false;
  });

  await redis.connect();
  return redis;
}

export async function disconnectRedis() {
  if (redis) {
    await redis.quit().catch(() => redis.disconnect());
    ready = false;
  }
}

import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Redis here does one job: Kafka event deduplication.
//
// Unlike geocoding-service, where a cache miss merely costs time, a dedup
// failure here would let a redelivered event be applied twice - so this is
// treated as a hard dependency rather than a nice-to-have.

let redis = null;
let ready = false;

export function getRedis() {
  if (!redis) throw new Error('redis is not initialised');
  return redis;
}

export const isRedisReady = () => ready;

export async function connectRedis() {
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    lazyConnect: true,
  });

  redis.on('ready', () => { ready = true; logger.info('redis connected'); });
  redis.on('error', (err) => { ready = false; logger.warn({ err: err.message }, 'redis error'); });
  redis.on('close', () => { ready = false; });

  await redis.connect();
  return redis;
}

export async function disconnectRedis() {
  if (redis) { await redis.quit().catch(() => redis.disconnect()); ready = false; }
}

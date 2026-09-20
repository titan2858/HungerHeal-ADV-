import { getRedis, isRedisReady } from '../config/redis.js';
import { env } from '../config/env.js';
import { STATS_HITS, STATS_MISSES, STATS_PROVIDER_CALLS, quotaKey } from './keys.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// The cache-aside pattern, which is the standard way to put a cache in front of
// a slow or costly source:
//
//   1. look in the cache
//   2. hit  -> return it
//   3. miss -> ask the real provider, store the answer, return it
//
// Two details below are what separate a cache that helps from one that causes
// its own outages: negative caching, and single-flight.
// ---------------------------------------------------------------------------

// In-flight lookups, keyed by cache key. See single-flight below.
const inFlight = new Map();

async function readCache(key) {
  if (!isRedisReady()) return null;
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    // A cache failure must never fail the request - it just becomes a miss.
    logger.warn({ err: err.message, key }, 'cache read failed, treating as a miss');
    return null;
  }
}

async function writeCache(key, value, ttlSeconds) {
  if (!isRedisReady()) return;
  try {
    // SETEX = SET with an expiry, in one atomic command. The TTL is what stops
    // this cache growing without bound: entries nobody asks for again simply
    // evaporate, with no cleanup job to write or run.
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    logger.warn({ err: err.message, key }, 'cache write failed');
  }
}

async function bump(counter) {
  if (!isRedisReady()) return;
  // INCR is atomic, so concurrent requests cannot lose a count between them.
  getRedis().incr(counter).catch(() => {});
}

// Guards the provider's daily free-tier allowance. The counter's name contains
// today's date, so it resets at midnight UTC by simply being a different key,
// and the TTL cleans up yesterday's without any scheduled job.
async function withinDailyQuota() {
  if (!isRedisReady()) return true; // no counter available; do not block work

  try {
    const key = quotaKey();
    const used = await getRedis().incr(key);
    if (used === 1) {
      // First call of the day: give the counter 48h so it disappears on its own.
      await getRedis().expire(key, 60 * 60 * 48);
    }
    return used <= env.DAILY_REQUEST_QUOTA;
  } catch {
    return true;
  }
}

export async function getQuotaUsage() {
  if (!isRedisReady()) return { used: null, limit: env.DAILY_REQUEST_QUOTA };
  const used = Number((await getRedis().get(quotaKey())) ?? 0);
  return { used, limit: env.DAILY_REQUEST_QUOTA, remaining: Math.max(0, env.DAILY_REQUEST_QUOTA - used) };
}

/**
 * Cache-aside lookup.
 *
 * @param key       cache key
 * @param lookup    () => Promise<result|null>  the real provider call
 * @param log       request-scoped logger
 */
export async function cachedLookup(key, lookup, log = logger) {
  const cached = await readCache(key);

  if (cached) {
    bump(STATS_HITS);
    log.debug({ key }, 'cache hit');
    // A cached "not found" is stored as { notFound: true } rather than absent,
    // so it can be told apart from never having been looked up.
    return { ...cached, cached: true };
  }

  bump(STATS_MISSES);

  // SINGLE-FLIGHT / cache stampede protection.
  //
  // When a popular address is requested by 50 clients at once and it is not
  // cached, the naive version makes 50 identical provider calls - burning 50
  // units of a 2500/day quota to compute one answer, and hitting the provider
  // hardest at exactly the moment it is most needed. Sharing one in-flight
  // promise means the other 49 wait for the first and all receive its result.
  if (inFlight.has(key)) {
    log.debug({ key }, 'joining an in-flight lookup instead of calling the provider again');
    return inFlight.get(key);
  }

  const promise = (async () => {
    if (!(await withinDailyQuota())) {
      const err = new Error('daily geocoding quota exhausted');
      err.quotaExhausted = true;
      throw err;
    }

    bump(STATS_PROVIDER_CALLS);
    const result = await lookup();

    if (result) {
      await writeCache(key, result, env.CACHE_TTL_SECONDS);
      return { ...result, cached: false };
    }

    // NEGATIVE CACHING. A typo'd address returns nothing, and without this
    // every retry of that same typo costs another provider call - so a client
    // in a retry loop can drain the whole daily quota on an address that will
    // never resolve. Cached briefly, not for 30 days, because "not found" can
    // become "found" when the provider updates its data.
    const miss = { notFound: true };
    await writeCache(key, miss, env.NEGATIVE_CACHE_TTL_SECONDS);
    return { ...miss, cached: false };
  })();

  inFlight.set(key, promise);

  try {
    return await promise;
  } finally {
    // Cleared whether it resolved or threw, so one failure does not poison
    // every later request for that address.
    inFlight.delete(key);
  }
}

export async function getStats() {
  if (!isRedisReady()) return null;

  const [hits, misses, providerCalls] = await getRedis().mget(
    STATS_HITS,
    STATS_MISSES,
    STATS_PROVIDER_CALLS,
  );

  const h = Number(hits ?? 0);
  const m = Number(misses ?? 0);
  const total = h + m;

  return {
    hits: h,
    misses: m,
    providerCalls: Number(providerCalls ?? 0),
    // The number that says whether the cache is worth having: the share of
    // lookups answered from RAM instead of a paid, rate-limited API call.
    hitRate: total === 0 ? null : Number(((h / total) * 100).toFixed(1)),
    quota: await getQuotaUsage(),
  };
}

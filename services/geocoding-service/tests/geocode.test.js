import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { token } from './setup.js';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectRedis, disconnectRedis, getRedis } = await import('../src/config/redis.js');
const { normalizeAddress, forwardKey, reverseKey } = await import('../src/cache/keys.js');
const { offlineProvider } = await import('../src/providers/offline.js');

const app = createApp();
const TOKEN = token();

const get = (path) => request(app).get(path).set('authorization', `Bearer ${TOKEN}`);

// Removes only this suite's keys, never the whole database - FLUSHALL would
// wipe agent locations and load counters that other services own.
async function clearGeoKeys() {
  const redis = getRedis();
  const keys = await redis.keys('geo:*');
  if (keys.length) await redis.del(...keys);
}

before(async () => {
  await connectRedis();
  await clearGeoKeys();
});

after(async () => {
  await clearGeoKeys();
  await disconnectRedis();
});

beforeEach(async () => {
  await clearGeoKeys();
});

describe('health and readiness', () => {
  test('GET /health reports which provider is active', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.service, 'geocoding-service');
    assert.equal(res.body.provider, 'offline');
  });

  test('GET /ready reports redis but stays ready regardless', async () => {
    const res = await request(app).get('/ready').expect(200);
    assert.equal(res.body.dependencies.redis, 'up');
  });
});

describe('address normalization - what makes the cache actually hit', () => {
  test('case, spacing and punctuation all fold to the same form', () => {
    const expected = '12 mg road bengaluru';
    assert.equal(normalizeAddress('12 MG Road, Bengaluru'), expected);
    assert.equal(normalizeAddress('  12   mg   road,   bengaluru  '), expected);
    assert.equal(normalizeAddress('12 MG ROAD., BENGALURU'), expected);
  });

  test('accents fold, so Bengalūru and Bengaluru are one key', () => {
    assert.equal(normalizeAddress('Bengalūru'), normalizeAddress('Bengaluru'));
  });

  test('different addresses still produce different keys', () => {
    assert.notEqual(forwardKey('12 MG Road'), forwardKey('13 MG Road'));
  });

  test('equivalent spellings produce one identical cache key', () => {
    assert.equal(forwardKey('12 MG Road, Bengaluru'), forwardKey('12  mg road,  BENGALURU'));
  });

  test('the raw address never appears in the key', () => {
    // Keys get listed by tooling; an address is someone's home.
    assert.ok(!forwardKey('12 MG Road, Bengaluru').includes('MG Road'));
    assert.match(forwardKey('12 MG Road'), /^geo:fwd:[0-9a-f]{40}$/);
  });

  test('reverse keys round to ~11m so a dragged pin can hit the cache', () => {
    // Without rounding, every pixel of pin movement is a fresh provider call.
    assert.equal(reverseKey(12.97161111, 77.59461111), reverseKey(12.97162222, 77.59462222));
    // But genuinely different places stay different.
    assert.notEqual(reverseKey(12.9716, 77.5946), reverseKey(12.9816, 77.5946));
  });
});

describe('GET /geocode', () => {
  test('resolves a known address to coordinates', async () => {
    const res = await get('/geocode?address=12 MG Road, Bengaluru').expect(200);

    assert.equal(typeof res.body.lat, 'number');
    assert.equal(typeof res.body.lng, 'number');
    // Bengaluru, roughly.
    assert.ok(res.body.lat > 12.8 && res.body.lat < 13.2);
    assert.ok(res.body.lng > 77.4 && res.body.lng < 77.8);
    assert.equal(res.body.provider, 'offline');
  });

  test('the first call is a miss and the second is a hit', async () => {
    const first = await get('/geocode?address=45 Church Street, Bengaluru').expect(200);
    assert.equal(first.body.cached, false);

    const second = await get('/geocode?address=45 Church Street, Bengaluru').expect(200);
    assert.equal(second.body.cached, true);

    // A cache that returns a different answer than the source is worse than no
    // cache at all.
    assert.equal(second.body.lat, first.body.lat);
    assert.equal(second.body.lng, first.body.lng);
  });

  test('a differently-spelled but equivalent address hits the same cache entry', async () => {
    await get('/geocode?address=12 MG Road, Bengaluru').expect(200);

    // This is the payoff of normalization: no second provider call.
    const res = await get('/geocode?address=  12   mg   ROAD,, bengaluru ').expect(200);
    assert.equal(res.body.cached, true);
  });

  test('writes the entry to redis with a TTL, so the cache cannot grow forever', async () => {
    await get('/geocode?address=Indiranagar, Bengaluru').expect(200);

    const ttl = await getRedis().ttl(forwardKey('Indiranagar, Bengaluru'));
    assert.ok(ttl > 0, 'entry must expire on its own');
    assert.ok(ttl <= 60, 'TTL should match the configured value');
  });

  test('returns 404 for an address that cannot be resolved', async () => {
    const res = await get('/geocode?address=nowhere at all, atlantis').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  test('caches the miss too, so a retry loop cannot drain the quota', async () => {
    await get('/geocode?address=nowhere at all, atlantis').expect(404);

    const cached = await getRedis().get(forwardKey('nowhere at all, atlantis'));
    assert.ok(cached, 'a not-found result must be cached');
    assert.equal(JSON.parse(cached).notFound, true);
  });

  test('gives the negative entry a SHORTER ttl than a successful one', async () => {
    await get('/geocode?address=nowhere at all, atlantis').expect(404);

    const ttl = await getRedis().ttl(forwardKey('nowhere at all, atlantis'));
    // "Not found" can become "found" when the provider updates its data, so it
    // must not be remembered for 30 days.
    assert.ok(ttl > 0 && ttl <= 5, `negative TTL should be short, got ${ttl}`);
  });

  test('rejects a missing address', async () => {
    await get('/geocode').expect(400);
  });

  test('rejects an address that is too short to mean anything', async () => {
    await get('/geocode?address=x').expect(400);
  });

  test('requires authentication, because every miss spends real quota', async () => {
    await request(app).get('/geocode?address=12 MG Road').expect(401);
  });
});

describe('GET /reverse - what the map pin drag calls', () => {
  test('turns coordinates into an address', async () => {
    const res = await get('/reverse?lat=12.9757&lng=77.6068').expect(200);

    assert.ok(res.body.formatted.length > 0);
    assert.equal(res.body.lat, 12.9757);
    assert.equal(res.body.cached, false);
  });

  test('a second identical lookup is cached', async () => {
    await get('/reverse?lat=12.9757&lng=77.6068').expect(200);
    const res = await get('/reverse?lat=12.9757&lng=77.6068').expect(200);
    assert.equal(res.body.cached, true);
  });

  test('a pin nudged by a metre reuses the cached answer', async () => {
    await get('/reverse?lat=12.9757&lng=77.6068').expect(200);

    // ~1m away. Without coordinate rounding this would be a fresh provider
    // call, and a dragged pin would fire dozens of them per second.
    const res = await get('/reverse?lat=12.97570912&lng=77.60680912').expect(200);
    assert.equal(res.body.cached, true);
  });

  test('rejects coordinates outside the valid range', async () => {
    await get('/reverse?lat=91&lng=77.6').expect(400);
    await get('/reverse?lat=12.9&lng=181').expect(400);
  });

  test('rejects a missing coordinate', async () => {
    await get('/reverse?lat=12.9').expect(400);
  });
});

describe('single-flight - cache stampede protection', () => {
  test('concurrent identical lookups make ONE provider call, not many', async () => {
    let providerCalls = 0;
    const original = offlineProvider.geocode;
    offlineProvider.geocode = async (address) => {
      providerCalls += 1;
      // A real provider takes time; without that delay the requests would not
      // actually overlap and the test would prove nothing.
      await new Promise((r) => setTimeout(r, 60));
      return original.call(offlineProvider, address);
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => get('/geocode?address=Koramangala, Bengaluru')),
      );

      for (const res of responses) assert.equal(res.status, 200);
      // The whole point: 12 simultaneous requests for an uncached address must
      // not spend 12 units of a 2500/day quota.
      assert.equal(providerCalls, 1, `expected 1 provider call, got ${providerCalls}`);

      // And they all got the same answer.
      const lats = new Set(responses.map((r) => r.body.lat));
      assert.equal(lats.size, 1);
    } finally {
      offlineProvider.geocode = original;
    }
  });
});

describe('GET /stats', () => {
  test('reports hits, misses and the resulting hit rate', async () => {
    await get('/geocode?address=Jayanagar, Bengaluru').expect(200); // miss
    await get('/geocode?address=Jayanagar, Bengaluru').expect(200); // hit
    await get('/geocode?address=Jayanagar, Bengaluru').expect(200); // hit

    const res = await get('/stats').expect(200);

    assert.equal(res.body.provider, 'offline');
    assert.equal(res.body.cache.hits, 2);
    assert.equal(res.body.cache.misses, 1);
    // 2 of 3 lookups answered from RAM instead of a paid API call.
    assert.equal(res.body.cache.hitRate, 66.7);
  });

  test('counts provider calls separately from misses', async () => {
    await get('/geocode?address=Hebbal, Bengaluru').expect(200);

    const res = await get('/stats').expect(200);
    assert.equal(res.body.cache.providerCalls, 1);
  });

  test('reports daily quota usage', async () => {
    await get('/geocode?address=Whitefield, Bengaluru').expect(200);

    const res = await get('/stats').expect(200);
    assert.equal(res.body.cache.quota.used, 1);
    assert.ok(res.body.cache.quota.remaining < res.body.cache.quota.limit);
  });
});

describe('the offline provider', () => {
  test('is deterministic - the same address always gives the same point', async () => {
    const a = await offlineProvider.geocode('77 Some Unknown Lane, Bengaluru');
    const b = await offlineProvider.geocode('77 Some Unknown Lane, Bengaluru');

    assert.deepEqual([a.lat, a.lng], [b.lat, b.lng]);
  });

  test('reports low confidence for an address it had to guess', async () => {
    const guessed = await offlineProvider.geocode('77 Some Unknown Lane, Bengaluru');
    const known = await offlineProvider.geocode('MG Road, Bengaluru');

    // A guess must not present itself as a precise match.
    assert.ok(guessed.confidence < known.confidence);
  });

  test('returns real coordinates for known landmarks', async () => {
    const res = await offlineProvider.geocode('Koramangala');
    assert.equal(res.lat, 12.9352);
    assert.equal(res.lng, 77.6245);
  });
});

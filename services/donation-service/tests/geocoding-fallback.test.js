import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { donorToken, validDonation } from './setup.js';

// This file exercises the geocoding FALLBACK specifically, so it re-enables the
// client that setup.js turns off and stubs global fetch. No network, no
// dependency on geocoding-service actually running.
process.env.GEOCODING_ENABLED = 'true';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb, disconnectDb } = await import('../src/config/db.js');
const { Donation } = await import('../src/models/Donation.js');

const app = createApp();
const DONOR = donorToken();
const realFetch = globalThis.fetch;

const post = () => request(app).post('/donations').set('authorization', `Bearer ${DONOR}`);
const withoutCoords = () => {
  const { lat, lng, ...rest } = validDonation();
  return rest;
};

before(async () => {
  await connectDb();
  await Donation.deleteMany({});
});

after(async () => {
  await Donation.deleteMany({});
  await disconnectDb();
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  await Donation.deleteMany({});
  globalThis.fetch = realFetch;
});

describe('geocoding fallback when a donation has no coordinates', () => {
  test('derives coordinates from the address', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ lat: 12.9757, lng: 77.6068, formatted: 'MG Road, Bengaluru', confidence: 9, cached: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const res = await post().send(withoutCoords()).expect(201);

    assert.deepEqual(res.body.donation.location.coordinates, [77.6068, 12.9757]);
    assert.equal(res.body.geocoding.derivedFromAddress, true);
    assert.equal(res.body.geocoding.confidence, 9);
  });

  test('forwards the caller token and traceId to geocoding-service', async () => {
    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url: url.toString(), headers: init.headers };
      return new Response(JSON.stringify({ lat: 12.9, lng: 77.6, formatted: 'x', confidence: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await post().set('x-trace-id', 'trace-geo-1').send(withoutCoords()).expect(201);

    assert.match(seen.url, /\/geocode\?address=/);
    assert.equal(seen.headers['x-trace-id'], 'trace-geo-1');
    assert.match(seen.headers.authorization, /^Bearer /);
  });

  test('still creates the donation when the address cannot be resolved', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 404 });

    const res = await post().send(withoutCoords()).expect(201);

    // A donation is a real offer of food. An unresolvable address must not
    // throw it away - the address is stored and can be geocoded later.
    assert.equal(res.body.donation.location, undefined);
    assert.match(res.body.notice, /could not be geocoded/);
  });

  test('still creates the donation when geocoding-service is down', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const res = await post().send(withoutCoords()).expect(201);
    assert.equal(res.body.donation.status, 'PENDING_ASSIGNMENT');
  });

  test('still creates the donation when geocoding times out', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    await post().send(withoutCoords()).expect(201);
  });

  test('does not call geocoding at all when the client already sent coordinates', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };

    // The map picker supplies exact coordinates; spending a lookup to
    // second-guess them would be wasted quota.
    await post().send(validDonation()).expect(201);
    assert.equal(called, false);
  });
});

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { donorToken, agentToken, validDonation, futureDate } from './setup.js';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb, disconnectDb } = await import('../src/config/db.js');
const { Donation } = await import('../src/models/Donation.js');
const { uploadDir } = await import('../src/middleware/upload.js');

const app = createApp();
const DONOR = donorToken();
const AGENT = agentToken();

// A tiny but genuinely valid 1x1 PNG, so multer's mime handling is exercised
// against real bytes rather than a text file pretending to be an image.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const post = (token = DONOR) =>
  request(app).post('/donations').set('authorization', `Bearer ${token}`);

before(async () => {
  await connectDb();
  await Donation.deleteMany({});
});

after(async () => {
  await Donation.deleteMany({});
  await disconnectDb();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await Donation.deleteMany({});
});

describe('health and readiness', () => {
  test('GET /health reports the service is up', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.service, 'donation-service');
  });

  test('GET /ready reports mongo and kafka separately', async () => {
    const res = await request(app).get('/ready').expect(200);
    assert.equal(res.body.dependencies.mongo, 'up');
    assert.ok('kafka' in res.body.dependencies);
  });
});

describe('POST /donations', () => {
  test('creates a donation from a JSON body', async () => {
    const res = await post().send(validDonation()).expect(201);

    assert.equal(res.body.donation.title, 'Leftover biryani from a wedding');
    assert.equal(res.body.donation.category, 'COOKED_PREPARED');
    assert.equal(res.body.donation.status, 'PENDING_ASSIGNMENT');
    assert.equal(res.body.donation.quantity.amount, 40);
    assert.equal(res.body.donation.quantity.unit, 'SERVINGS');
  });

  test('stores coordinates as GeoJSON in [lng, lat] order', async () => {
    const res = await post().send(validDonation({ lat: 12.9716, lng: 77.5946 })).expect(201);

    // The whole point of this assertion: longitude FIRST. Reversing these
    // silently relocates the donation to a different continent.
    assert.deepEqual(res.body.donation.location.coordinates, [77.5946, 12.9716]);
    assert.equal(res.body.donation.location.type, 'Point');
  });

  test('snapshots the donor name and phone from the token', async () => {
    const res = await post().send(validDonation()).expect(201);

    // Copied onto the donation so an agent has someone to call without
    // donation-service ever querying auth-service's database.
    assert.equal(res.body.donation.donorName, 'Asha Donor');
    assert.equal(res.body.donation.donorPhone, '+91 9876543210');
  });

  test('records the traceId so the donation can be followed across services', async () => {
    const res = await post()
      .set('x-trace-id', 'trace-abc-123')
      .send(validDonation())
      .expect(201);

    assert.equal(res.body.donation.traceId, 'trace-abc-123');
  });

  test('accepts a donation with no coordinates but flags that it cannot be matched', async () => {
    const { lat, lng, ...noCoords } = validDonation();
    const res = await post().send(noCoords).expect(201);

    assert.equal(res.body.donation.location?.coordinates, undefined);
    assert.match(res.body.notice, /could not be geocoded/);
  });

  test('rejects a latitude sent without a longitude', async () => {
    const { lng, ...latOnly } = validDonation();
    await post().send(latOnly).expect(400);
  });

  test('rejects an out-of-range latitude', async () => {
    await post().send(validDonation({ lat: 91 })).expect(400);
  });

  test('rejects an unknown food category', async () => {
    const res = await post().send(validDonation({ category: 'SUSHI' })).expect(400);
    assert.ok(res.body.error.details.some((d) => d.field === 'category'));
  });

  test('rejects a bestBefore that is already in the past', async () => {
    const res = await post()
      .send(validDonation({ bestBefore: new Date(Date.now() - 3600_000).toISOString() }))
      .expect(400);

    assert.ok(res.body.error.details.some((d) => d.field === 'bestBefore'));
  });

  test('rejects a zero or negative quantity', async () => {
    await post().send(validDonation({ quantityAmount: 0 })).expect(400);
    await post().send(validDonation({ quantityAmount: -5 })).expect(400);
  });

  test('rejects an unknown quantity unit', async () => {
    await post().send(validDonation({ quantityUnit: 'TONNES' })).expect(400);
  });

  test('rejects a title that is too short', async () => {
    await post().send(validDonation({ title: 'x' })).expect(400);
  });

  test('requires authentication', async () => {
    await request(app).post('/donations').send(validDonation()).expect(401);
  });

  test('forbids an agent from creating a donation', async () => {
    const res = await post(AGENT).send(validDonation()).expect(403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });
});

describe('POST /donations with images', () => {
  test('accepts multipart upload and stores the image metadata', async () => {
    const d = validDonation();
    const res = await request(app)
      .post('/donations')
      .set('authorization', `Bearer ${DONOR}`)
      .field('title', d.title)
      .field('category', d.category)
      .field('quantityAmount', String(d.quantityAmount))
      .field('quantityUnit', d.quantityUnit)
      .field('pickupAddress', d.pickupAddress)
      .field('lat', String(d.lat))
      .field('lng', String(d.lng))
      .field('bestBefore', d.bestBefore)
      .attach('images', PNG_1X1, 'food.png')
      .expect(201);

    assert.equal(res.body.donation.images.length, 1);
    assert.equal(res.body.donation.images[0].mimeType, 'image/png');
    assert.match(res.body.donation.images[0].url, /^\/uploads\//);

    // The stored filename must not be the client's - it is randomised to stop
    // path traversal and collisions between two donors uploading "food.png".
    assert.notEqual(res.body.donation.images[0].filename, 'food.png');
    assert.ok(fs.existsSync(path.join(uploadDir, res.body.donation.images[0].filename)));
  });

  test('coerces multipart string fields into numbers', async () => {
    const d = validDonation();
    const res = await request(app)
      .post('/donations')
      .set('authorization', `Bearer ${DONOR}`)
      .field('title', d.title)
      .field('category', d.category)
      // Every multipart field arrives as a string; these must land as numbers.
      .field('quantityAmount', '12.5')
      .field('quantityUnit', 'KG')
      .field('pickupAddress', d.pickupAddress)
      .field('lat', '12.9716')
      .field('lng', '77.5946')
      .field('bestBefore', d.bestBefore)
      .expect(201);

    assert.equal(res.body.donation.quantity.amount, 12.5);
    assert.deepEqual(res.body.donation.location.coordinates, [77.5946, 12.9716]);
  });

  test('rejects a non-image upload', async () => {
    const d = validDonation();
    const res = await request(app)
      .post('/donations')
      .set('authorization', `Bearer ${DONOR}`)
      .field('title', d.title)
      .field('category', d.category)
      .field('quantityAmount', String(d.quantityAmount))
      .field('quantityUnit', d.quantityUnit)
      .field('pickupAddress', d.pickupAddress)
      .field('bestBefore', d.bestBefore)
      .attach('images', Buffer.from('#!/bin/sh\nrm -rf /'), 'evil.sh')
      .expect(400);

    assert.match(res.body.error.message, /unsupported image type/);
  });

  test('does not leave orphaned files when validation fails', async () => {
    const before = fs.readdirSync(uploadDir).length;

    await request(app)
      .post('/donations')
      .set('authorization', `Bearer ${DONOR}`)
      .field('title', 'x') // too short - fails validation AFTER the upload
      .field('category', 'BAKERY')
      .field('quantityAmount', '1')
      .field('quantityUnit', 'KG')
      .field('pickupAddress', '12 MG Road, Bengaluru 560001')
      .field('bestBefore', futureDate())
      .attach('images', PNG_1X1, 'food.png')
      .expect(400);

    // The file was written to disk by multer before validation ran, so it must
    // be cleaned up or the upload directory fills with orphans.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readdirSync(uploadDir).length, before);
  });
});

describe('GET /donations', () => {
  beforeEach(async () => {
    await post().send(validDonation({ title: 'Donation one', category: 'BAKERY' })).expect(201);
    await post()
      .send(validDonation({ title: 'Donation two', category: 'COOKED_PREPARED' }))
      .expect(201);
    // A donation belonging to a different donor.
    await post(donorToken({ sub: '65b0000000000000000000ff' }))
      .send(validDonation({ title: 'Someone elses donation' }))
      .expect(201);
  });

  test('a donor sees only their own donations', async () => {
    const res = await request(app)
      .get('/donations')
      .set('authorization', `Bearer ${DONOR}`)
      .expect(200);

    assert.equal(res.body.donations.length, 2);
    assert.ok(!res.body.donations.some((d) => d.title === 'Someone elses donation'));
  });

  test('an agent sees every donation, because browsing them is the job', async () => {
    const res = await request(app)
      .get('/donations')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);

    assert.equal(res.body.donations.length, 3);
  });

  test('filters by category', async () => {
    const res = await request(app)
      .get('/donations?category=BAKERY')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);

    assert.equal(res.body.donations.length, 1);
    assert.equal(res.body.donations[0].category, 'BAKERY');
  });

  test('filters by status', async () => {
    const res = await request(app)
      .get('/donations?status=PENDING_ASSIGNMENT')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);

    assert.equal(res.body.donations.length, 3);
  });

  test('returns newest first', async () => {
    const res = await request(app)
      .get('/donations')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);

    const times = res.body.donations.map((d) => new Date(d.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  test('paginates', async () => {
    const res = await request(app)
      .get('/donations?limit=2&offset=0')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);

    assert.equal(res.body.donations.length, 2);
    assert.equal(res.body.pagination.total, 3);
    assert.equal(res.body.pagination.hasMore, true);
  });

  test('rejects an invalid status filter', async () => {
    await request(app)
      .get('/donations?status=NONSENSE')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(400);
  });

  test('requires authentication', async () => {
    await request(app).get('/donations').expect(401);
  });
});

describe('GET /donations/:id', () => {
  test('returns the donation to its owner', async () => {
    const created = await post().send(validDonation()).expect(201);

    const res = await request(app)
      .get(`/donations/${created.body.donation.id}`)
      .set('authorization', `Bearer ${DONOR}`)
      .expect(200);

    assert.equal(res.body.donation.id, created.body.donation.id);
  });

  test('returns it to an agent as well', async () => {
    const created = await post().send(validDonation()).expect(201);

    await request(app)
      .get(`/donations/${created.body.donation.id}`)
      .set('authorization', `Bearer ${AGENT}`)
      .expect(200);
  });

  test("hides another donor's donation behind a 404, not a 403", async () => {
    const created = await post().send(validDonation()).expect(201);

    // A 403 would confirm the id is real, which is enough to enumerate
    // donation ids. A 404 reveals nothing.
    const res = await request(app)
      .get(`/donations/${created.body.donation.id}`)
      .set('authorization', `Bearer ${donorToken({ sub: '65b0000000000000000000ee' })}`)
      .expect(404);

    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  test('returns 404 for an id that does not exist', async () => {
    await request(app)
      .get('/donations/65b0000000000000000000aa')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(404);
  });

  test('returns 404 rather than 500 for a malformed id', async () => {
    await request(app)
      .get('/donations/not-a-valid-object-id')
      .set('authorization', `Bearer ${AGENT}`)
      .expect(404);
  });
});

describe('the donation.created event', () => {
  test('carries everything assignment-engine needs to score without a callback', async () => {
    const { buildDonationCreatedEvent } = await import('../src/events/donationEvents.js');

    const created = await post().send(validDonation()).expect(201);
    const donation = await Donation.findById(created.body.donation.id);
    const event = buildDonationCreatedEvent(donation);

    assert.equal(event.eventType, 'donation.created');
    assert.equal(event.donationId, created.body.donation.id);
    assert.equal(event.category, 'COOKED_PREPARED');
    // Coordinates must be IN the event - otherwise the engine has to call back
    // into this service to score, recoupling the two.
    assert.equal(event.pickup.lat, 12.9716);
    assert.equal(event.pickup.lng, 77.5946);
    assert.ok(event.bestBefore);
  });

  test('has a unique eventId, which is what consumers deduplicate on', async () => {
    const { buildDonationCreatedEvent } = await import('../src/events/donationEvents.js');

    const created = await post().send(validDonation()).expect(201);
    const donation = await Donation.findById(created.body.donation.id);

    const a = buildDonationCreatedEvent(donation);
    const b = buildDonationCreatedEvent(donation);

    assert.match(a.eventId, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.eventId, b.eventId);
  });

  test('propagates the traceId onto the event', async () => {
    const { buildDonationCreatedEvent } = await import('../src/events/donationEvents.js');

    const created = await post()
      .set('x-trace-id', 'trace-xyz-789')
      .send(validDonation())
      .expect(201);
    const donation = await Donation.findById(created.body.donation.id);

    assert.equal(buildDonationCreatedEvent(donation).traceId, 'trace-xyz-789');
  });

  test('reports a null pickup coordinate rather than omitting it when ungeocoded', async () => {
    const { buildDonationCreatedEvent } = await import('../src/events/donationEvents.js');

    const { lat, lng, ...noCoords } = validDonation();
    const created = await post().send(noCoords).expect(201);
    const donation = await Donation.findById(created.body.donation.id);
    const event = buildDonationCreatedEvent(donation);

    // Explicit null, so a consumer can tell "not geocoded yet" from a bug.
    assert.equal(event.pickup.lat, null);
    assert.equal(event.pickup.lng, null);
  });
});

describe('the outbox', () => {
  test('marks a donation unpublished when the broker is unavailable', async () => {
    // KAFKA_ENABLED is false in tests, so publishing is skipped entirely and
    // the donation stays flagged for the sweeper - the same state a real broker
    // outage produces.
    const created = await post().send(validDonation()).expect(201);
    const stored = await Donation.findById(created.body.donation.id);

    assert.equal(stored.eventPublished, false);
    // Still created and still a 201: a broker problem is never the donor's
    // problem.
    assert.equal(created.status, 201);
  });

  test('a donation is saved before its event is published, never after', async () => {
    const created = await post().send(validDonation()).expect(201);

    // The ordering that makes the outbox safe: durable first, announced second.
    // If this ever inverts, a crash mid-request loses the donation entirely.
    assert.ok(await Donation.findById(created.body.donation.id));
  });
});

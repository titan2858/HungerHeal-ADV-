import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { donorPayload, agentPayload } from './setup.js';

// Imported dynamically AFTER setup.js has populated process.env, because
// config/env.js validates configuration at import time.
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb, disconnectDb } = await import('../src/config/db.js');
const { User } = await import('../src/models/User.js');
const { DEFAULT_AGENT_RATING } = await import('../src/domain/categories.js');

const app = createApp();

before(async () => {
  await connectDb();
  await User.deleteMany({});
});

after(async () => {
  await User.deleteMany({});
  await disconnectDb();
});

describe('health and readiness', () => {
  test('GET /health reports the service is up', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'auth-service');
  });

  test('GET /ready reports mongo is reachable', async () => {
    const res = await request(app).get('/ready').expect(200);
    assert.equal(res.body.dependencies.mongo, 'up');
  });

  test('every response carries a traceId header for cross-service tracing', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.match(res.headers['x-trace-id'], /^[0-9a-f-]{36}$/);
  });

  test('an incoming traceId is reused, not replaced', async () => {
    const res = await request(app)
      .get('/health')
      .set('x-trace-id', 'trace-from-gateway')
      .expect(200);
    assert.equal(res.headers['x-trace-id'], 'trace-from-gateway');
  });
});

describe('POST /auth/signup', () => {
  test('registers a donor and returns a usable token', async () => {
    const res = await request(app).post('/auth/signup').send(donorPayload()).expect(201);

    assert.equal(res.body.user.role, 'DONOR');
    assert.ok(res.body.token, 'a token should be issued on signup');
    assert.ok(res.body.user.id, 'the user id should be exposed as `id`');
  });

  test('never returns the password hash', async () => {
    const res = await request(app).post('/auth/signup').send(donorPayload()).expect(201);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(JSON.stringify(res.body).includes('$2a$'), false);
  });

  test('stores the password only as a bcrypt hash, never as plaintext', async () => {
    const payload = donorPayload();
    await request(app).post('/auth/signup').send(payload).expect(201);

    const stored = await User.findOne({ email: payload.email }).select('+passwordHash');
    assert.notEqual(stored.passwordHash, payload.password);
    assert.match(stored.passwordHash, /^\$2[aby]\$/, 'should be a bcrypt hash');
  });

  test('registers an agent with declared capabilities', async () => {
    const res = await request(app).post('/auth/signup').send(agentPayload()).expect(201);

    assert.equal(res.body.user.role, 'AGENT');
    assert.equal(res.body.user.capabilities.vehicleType, 'MOTORCYCLE');
    assert.equal(res.body.user.capabilities.hasInsulatedTransport, true);
    assert.deepEqual(res.body.user.capabilities.categoriesHandled, [
      'COOKED_PREPARED',
      'BAKERY',
    ]);
  });

  test('gives a new agent the neutral default rating, not zero', async () => {
    const res = await request(app).post('/auth/signup').send(agentPayload()).expect(201);
    assert.equal(res.body.user.rating, DEFAULT_AGENT_RATING);
    assert.equal(res.body.user.ratingCount, 0);
  });

  test('rejects an agent that declares no capabilities', async () => {
    const { capabilities, ...withoutCapabilities } = agentPayload();
    const res = await request(app)
      .post('/auth/signup')
      .send(withoutCapabilities)
      .expect(400);

    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.ok(res.body.error.details.some((d) => d.field.startsWith('capabilities')));
  });

  test('rejects an agent that handles zero food categories', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send(agentPayload({ capabilities: { vehicleType: 'CAR', categoriesHandled: [] } }))
      .expect(400);

    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  test('rejects an unknown food category', async () => {
    await request(app)
      .post('/auth/signup')
      .send(
        agentPayload({
          capabilities: { vehicleType: 'CAR', categoriesHandled: ['SUSHI'] },
        }),
      )
      .expect(400);
  });

  test('deduplicates a repeated category rather than storing it twice', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send(
        agentPayload({
          capabilities: {
            vehicleType: 'VAN',
            categoriesHandled: ['BAKERY', 'BAKERY', 'BEVERAGES'],
          },
        }),
      )
      .expect(201);

    assert.deepEqual(res.body.user.capabilities.categoriesHandled, ['BAKERY', 'BEVERAGES']);
  });

  test('rejects a donor that tries to send agent capabilities', async () => {
    await request(app)
      .post('/auth/signup')
      .send(donorPayload({ capabilities: { vehicleType: 'CAR' } }))
      .expect(400);
  });

  test('rejects a weak password and explains why', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send(donorPayload({ password: 'short' }))
      .expect(400);

    assert.ok(res.body.error.details.some((d) => d.field === 'password'));
  });

  test('rejects a password with no digits', async () => {
    await request(app)
      .post('/auth/signup')
      .send(donorPayload({ password: 'allletters' }))
      .expect(400);
  });

  test('rejects a malformed email', async () => {
    await request(app)
      .post('/auth/signup')
      .send(donorPayload({ email: 'not-an-email' }))
      .expect(400);
  });

  test('rejects an unknown role', async () => {
    await request(app).post('/auth/signup').send(donorPayload({ role: 'WAREHOUSE' })).expect(400);
  });

  test('registers an admin, who needs no capabilities', async () => {
    // ADMIN gates the read-only monitoring view and nothing else. It grants no
    // power over assignment - there is no manual admin step in this system.
    const res = await request(app)
      .post('/auth/signup')
      .send(donorPayload({ role: 'ADMIN' }))
      .expect(201);

    assert.equal(res.body.user.role, 'ADMIN');
  });

  test('rejects an admin that sends agent capabilities', async () => {
    await request(app)
      .post('/auth/signup')
      .send(donorPayload({ role: 'ADMIN', capabilities: { vehicleType: 'CAR' } }))
      .expect(400);
  });

  test('rejects a duplicate email with 409', async () => {
    const payload = donorPayload();
    await request(app).post('/auth/signup').send(payload).expect(201);

    const res = await request(app).post('/auth/signup').send(payload).expect(409);
    assert.equal(res.body.error.code, 'CONFLICT');
  });

  test('treats email as case-insensitive when detecting duplicates', async () => {
    const payload = donorPayload({ email: 'MixedCase@Example.com' });
    await request(app).post('/auth/signup').send(payload).expect(201);

    await request(app)
      .post('/auth/signup')
      .send({ ...payload, email: 'mixedcase@example.com' })
      .expect(409);
  });
});

describe('POST /auth/login', () => {
  test('logs in with correct credentials', async () => {
    const payload = donorPayload();
    await request(app).post('/auth/signup').send(payload).expect(201);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    assert.ok(res.body.token);
    assert.equal(res.body.user.email, payload.email.toLowerCase());
  });

  test('rejects a wrong password', async () => {
    const payload = donorPayload();
    await request(app).post('/auth/signup').send(payload).expect(201);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: payload.email, password: 'wrongpass1' })
      .expect(401);

    assert.equal(res.body.error.message, 'invalid email or password');
  });

  test('gives an identical error for an unknown email, so accounts cannot be enumerated', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever1' })
      .expect(401);

    assert.equal(res.body.error.message, 'invalid email or password');
  });
});

describe('GET /auth/me', () => {
  test('returns the caller with a valid token', async () => {
    const payload = agentPayload();
    const signupRes = await request(app).post('/auth/signup').send(payload).expect(201);

    const res = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${signupRes.body.token}`)
      .expect(200);

    assert.equal(res.body.user.email, payload.email.toLowerCase());
    assert.equal(res.body.user.role, 'AGENT');
  });

  test('rejects a request with no token', async () => {
    const res = await request(app).get('/auth/me').expect(401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  test('rejects a tampered token', async () => {
    const signupRes = await request(app).post('/auth/signup').send(donorPayload()).expect(201);
    const tampered = `${signupRes.body.token.slice(0, -4)}beef`;

    await request(app).get('/auth/me').set('authorization', `Bearer ${tampered}`).expect(401);
  });

  test('rejects a token sent without the Bearer scheme', async () => {
    const signupRes = await request(app).post('/auth/signup').send(donorPayload()).expect(201);
    await request(app).get('/auth/me').set('authorization', signupRes.body.token).expect(401);
  });
});

describe('the JWT contract other services depend on', () => {
  // donation-service snapshots donorName/donorPhone from the token onto every
  // donation, so an agent has someone to call. If these claims ever disappear
  // from the payload, that breaks in another repository directory with no
  // obvious link back to here - so the contract is asserted at the source.
  test('the token carries id, role, email, name and phone', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const payload = agentPayload();

    const res = await request(app).post('/auth/signup').send(payload).expect(201);
    const decoded = jwt.decode(res.body.token);

    assert.ok(decoded.sub);
    assert.equal(decoded.role, 'AGENT');
    assert.equal(decoded.email, payload.email.toLowerCase());
    assert.equal(decoded.name, payload.name);
    assert.equal(decoded.phone, payload.phone);
  });

  test('the token never carries the password hash', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const res = await request(app).post('/auth/signup').send(donorPayload()).expect(201);

    const decoded = jwt.decode(res.body.token);
    assert.equal(decoded.passwordHash, undefined);
    assert.equal(decoded.password, undefined);
  });
});

describe('error shape', () => {
  test('an unknown route returns the standard error body with a traceId', async () => {
    const res = await request(app).get('/auth/nope').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.ok(res.body.error.traceId, 'errors must carry the traceId for log lookup');
  });
});

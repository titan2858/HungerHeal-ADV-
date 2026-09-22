import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// Pure: no Mongo, no Kafka. Deciding WHICH notifications an event should
// produce is a rule worth testing on its own, separately from whether they get
// stored.
const { notificationsFor, offerClosedFor, RECIPIENT, KIND, PRIORITY } = await import(
  '../src/domain/templates.js'
);

const assignedEvent = (overrides = {}) => ({
  eventId: 'evt-1',
  donationId: 'don-1',
  donorId: 'donor-1',
  category: 'COOKED_PREPARED',
  responseTimeoutSeconds: 90,
  round: 1,
  pickup: { address: '12 MG Road, Bengaluru' },
  offers: [
    { agentId: 'agent-a', agentName: 'Ravi', rank: 1, score: 0.81 },
    { agentId: 'agent-b', agentName: 'Priya', rank: 2, score: 0.74 },
    { agentId: 'agent-c', agentName: 'Sunil', rank: 3, score: 0.66 },
  ],
  ...overrides,
});

describe('offers', () => {
  test('one notification per offered agent - the parallel offer made visible', () => {
    const notifications = notificationsFor('donation.assigned', assignedEvent());

    assert.equal(notifications.length, 3);
    for (const n of notifications) {
      assert.equal(n.recipientRole, RECIPIENT.AGENT);
      assert.equal(n.kind, KIND.OFFER);
      // Time-sensitive: it should outrank routine updates in the inbox.
      assert.equal(n.priority, PRIORITY.HIGH);
    }

    const ids = notifications.map((n) => n.recipientId);
    assert.deepEqual(ids, ['agent-a', 'agent-b', 'agent-c']);
  });

  test('the offer carries its deadline so the app can show a countdown', () => {
    const [first] = notificationsFor('donation.assigned', assignedEvent());
    assert.equal(first.expiresInSeconds, 90);
    assert.match(first.body, /90 seconds/);
  });

  test('the donor is NOT notified that agents were asked', () => {
    // A donor does not need a notification per offer round. Telling them every
    // time a batch is asked would be noise that teaches them to ignore the app.
    const notifications = notificationsFor('donation.assigned', assignedEvent());
    assert.equal(notifications.some((n) => n.recipientRole === RECIPIENT.DONOR), false);
  });

  test('a re-offer says so, rather than looking like a fresh request', () => {
    const notifications = notificationsFor('donation.assigned', assignedEvent({ round: 3 }));
    assert.ok(notifications.length > 0);
    assert.equal(notifications[0].meta.round, 3);
  });

  test('the pickup address is in the body, because that is what decides the answer', () => {
    const [first] = notificationsFor('donation.assigned', assignedEvent());
    assert.match(first.body, /MG Road/);
  });
});

describe('acceptance', () => {
  const accepted = {
    eventId: 'evt-2',
    donationId: 'don-1',
    donorId: 'donor-1',
    agentId: 'agent-a',
    agentName: 'Ravi',
    agentPhone: '+91 9876500000',
    responseSeconds: 12.5,
  };

  test('the donor is told who is coming, with a phone number', () => {
    const notifications = notificationsFor('donation.accepted', accepted);
    const donorNote = notifications.find((n) => n.recipientRole === RECIPIENT.DONOR);

    assert.ok(donorNote);
    assert.match(donorNote.body, /Ravi/);
    // A name without a number is not actionable when the agent is at the wrong
    // gate.
    assert.match(donorNote.body, /9876500000/);
  });

  test('the winning agent gets a confirmation too', () => {
    const notifications = notificationsFor('donation.accepted', accepted);
    const agentNote = notifications.find((n) => n.recipientId === 'agent-a');

    assert.ok(agentNote);
    assert.match(agentNote.body, /mark it collected/i);
  });

  test('a missing phone number does not break the message', () => {
    const { agentPhone, ...withoutPhone } = accepted;
    const notifications = notificationsFor('donation.accepted', withoutPhone);
    const donorNote = notifications.find((n) => n.recipientRole === RECIPIENT.DONOR);

    assert.ok(donorNote.body.length > 0);
    assert.equal(donorNote.body.includes('undefined'), false);
  });
});

describe('nobody found - the reason changes the message', () => {
  const base = { eventId: 'evt-3', donationId: 'don-1', donorId: 'donor-1' };

  test('an ungeocoded address asks the donor to act', () => {
    // This one the donor can actually fix, so it is ACTION_NEEDED rather than
    // a progress update they can only watch.
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'NOT_GEOCODED' });
    assert.equal(n.kind, KIND.ACTION_NEEDED);
    assert.match(n.body, /map/i);
  });

  test('nobody online is a progress update, not a demand', () => {
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'NO_AGENTS_FOUND' });
    assert.equal(n.kind, KIND.DONATION_UPDATE);
    assert.match(n.body, /keep trying/i);
  });

  test('agents nearby but none suitable says exactly that', () => {
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'NO_ELIGIBLE_AGENTS' });
    assert.match(n.body, /none can carry/i);
  });

  test('everyone having declined is escalated', () => {
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'ALL_AGENTS_EXHAUSTED' });
    assert.equal(n.kind, KIND.ACTION_NEEDED);
    assert.equal(n.priority, PRIORITY.HIGH);
  });

  test('an unrecognised reason still produces a sensible message', () => {
    // A new reason code added by assignment-engine must not produce an empty
    // or broken notification here.
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'SOMETHING_NEW' });
    assert.ok(n);
    assert.ok(n.title.length > 0 && n.body.length > 0);
  });

  test('the reason is kept in meta so the UI can branch on it', () => {
    const [n] = notificationsFor('donation.unassigned', { ...base, reason: 'NO_AGENTS_FOUND', retryable: true });
    assert.equal(n.meta.reason, 'NO_AGENTS_FOUND');
    assert.equal(n.meta.retryable, true);
  });
});

describe('events that produce no notification', () => {
  test('one agent declining tells the donor nothing', () => {
    // The other two are still deciding. A notification per decline would be
    // noise, and alarming noise at that.
    const notifications = notificationsFor('donation.rejected', {
      donationId: 'don-1', donorId: 'donor-1', agentId: 'agent-a',
    });
    assert.equal(notifications.length, 0);
  });

  test('a timeout tells the donor nothing, because the engine is already re-offering', () => {
    const notifications = notificationsFor('donation.timeout', {
      donationId: 'don-1', donorId: 'donor-1', round: 1,
    });
    assert.equal(notifications.length, 0);
  });

  test('an unknown event type produces nothing rather than throwing', () => {
    assert.deepEqual(notificationsFor('donation.something.new', { donationId: 'x' }), []);
  });
});

describe('collection', () => {
  test('the donor is thanked', () => {
    const [n] = notificationsFor('donation.collected', {
      donationId: 'don-1', donorId: 'donor-1', agentName: 'Ravi',
    });
    assert.equal(n.recipientRole, RECIPIENT.DONOR);
    assert.match(n.body, /Ravi/);
  });
});

describe('closing losing offers', () => {
  test('every loser is told the request is closed', () => {
    // Otherwise their app counts down an offer somebody else already took,
    // they tap Accept, get a 409, and conclude the app is broken.
    const closed = offerClosedFor(['agent-b', 'agent-c'], { donationId: 'don-1' });

    assert.equal(closed.length, 2);
    for (const n of closed) {
      assert.equal(n.kind, KIND.OFFER_CLOSED);
      // Informational only - it should not buzz a phone.
      assert.equal(n.priority, PRIORITY.LOW);
    }
  });
});

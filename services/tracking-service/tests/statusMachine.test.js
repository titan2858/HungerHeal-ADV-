import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// The state machine is pure, so these run with no Mongo, no Kafka and no
// Docker. A failure here means the LIFECYCLE RULES are wrong, never that a
// broker was slow.
const { STATUS, canTransition, applyEvent, isTerminal, DONOR_MESSAGE } = await import(
  '../src/domain/statusMachine.js'
);

describe('terminal states', () => {
  test('collected, cancelled and expired are terminal', () => {
    assert.ok(isTerminal(STATUS.COLLECTED));
    assert.ok(isTerminal(STATUS.CANCELLED));
    assert.ok(isTerminal(STATUS.EXPIRED));
  });

  test('in-flight states are not terminal', () => {
    for (const s of [STATUS.PENDING_ASSIGNMENT, STATUS.OFFERED, STATUS.ACCEPTED, STATUS.UNASSIGNED]) {
      assert.equal(isTerminal(s), false, `${s} should not be terminal`);
    }
  });

  test('nothing can move a collected donation', () => {
    // The most important guard in the file. A redelivered donation.assigned
    // arriving after collection would otherwise move finished food back to
    // OFFERED and re-notify agents about a pickup that already happened.
    for (const event of ['donation.assigned', 'donation.accepted', 'donation.unassigned']) {
      const result = applyEvent(STATUS.COLLECTED, event);
      assert.equal(result.changed, false, `${event} must not move a collected donation`);
      assert.equal(result.reason, 'ALREADY_TERMINAL');
      assert.equal(result.nextStatus, STATUS.COLLECTED);
    }
  });
});

describe('the normal path', () => {
  test('created -> offered -> accepted -> collected', () => {
    let status = STATUS.PENDING_ASSIGNMENT;

    for (const [event, expected] of [
      ['donation.assigned', STATUS.OFFERED],
      ['donation.accepted', STATUS.ACCEPTED],
      ['donation.collected', STATUS.COLLECTED],
    ]) {
      const result = applyEvent(status, event);
      assert.equal(result.changed, true, `${event} should change the status`);
      assert.equal(result.nextStatus, expected);
      status = result.nextStatus;
    }
  });
});

describe('out-of-order delivery', () => {
  test('accepted can arrive before assigned', () => {
    // Every event for one donation is keyed by donationId, so events on the
    // SAME topic arrive in order. But donation.assigned and donation.accepted
    // are different topics - different partitions, consumed independently - so
    // there is no ordering guarantee between them.
    const result = applyEvent(STATUS.PENDING_ASSIGNMENT, 'donation.accepted');
    assert.equal(result.changed, true);
    assert.equal(result.nextStatus, STATUS.ACCEPTED);
  });

  test('a late assigned does not drag an accepted donation backwards', () => {
    const result = applyEvent(STATUS.ACCEPTED, 'donation.assigned');
    assert.equal(result.changed, true);
    // ACCEPTED -> OFFERED is legal on purpose: an agent can accept and then
    // fail to show up, which puts the donation back on the market. The
    // protection against a stale redelivery is the dedup key, not this rule.
    assert.equal(result.nextStatus, STATUS.OFFERED);
  });

  test('collected cannot be undone by a late event', () => {
    assert.equal(applyEvent(STATUS.COLLECTED, 'donation.assigned').changed, false);
  });
});

describe('events that record history without changing status', () => {
  test('one agent declining leaves the donation offered', () => {
    // The other two are still deciding. Flipping the status on one decline
    // would misrepresent what is happening.
    const result = applyEvent(STATUS.OFFERED, 'donation.rejected');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'TIMELINE_ONLY');
    assert.equal(result.nextStatus, STATUS.OFFERED);
  });

  test('a timeout leaves the donation offered while the engine re-scores', () => {
    const result = applyEvent(STATUS.OFFERED, 'donation.timeout');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'TIMELINE_ONLY');
  });

  test('an unknown event type is ignored rather than throwing', () => {
    // A new event type deployed by another service must not crash this one.
    const result = applyEvent(STATUS.OFFERED, 'donation.something.new');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'UNKNOWN_EVENT');
  });
});

describe('re-offering', () => {
  test('offered -> offered is allowed, because a re-offer is a real event', () => {
    const result = applyEvent(STATUS.OFFERED, 'donation.assigned');
    assert.equal(result.changed, true, 'a new offer round should register');
  });

  test('an unassigned donation can be offered again when agents come online', () => {
    const result = applyEvent(STATUS.UNASSIGNED, 'donation.assigned');
    assert.equal(result.changed, true);
    assert.equal(result.nextStatus, STATUS.OFFERED);
  });

  test('accepted -> accepted does not re-register', () => {
    const result = applyEvent(STATUS.ACCEPTED, 'donation.accepted');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'NO_CHANGE');
  });
});

describe('illegal transitions', () => {
  test('a donation cannot be collected before it is accepted', () => {
    // Nobody has claimed it, so there is nobody who could have collected it.
    const result = applyEvent(STATUS.OFFERED, 'donation.collected');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'ILLEGAL_TRANSITION');
  });

  test('canTransition rejects an unknown target status', () => {
    assert.equal(canTransition(STATUS.OFFERED, 'TELEPORTED'), false);
  });

  test('a donation with no status yet can start anywhere', () => {
    assert.equal(canTransition(null, STATUS.OFFERED), true);
  });
});

describe('donor-facing wording', () => {
  test('every status has a sentence a donor can read', () => {
    // The codes are for machines. Someone waiting on a collection wants to
    // know what is happening, not read an enum.
    for (const status of Object.values(STATUS)) {
      const message = DONOR_MESSAGE[status];
      assert.ok(message, `${status} has no donor message`);
      assert.ok(message.length > 5, `${status}'s message is too terse`);
      assert.notEqual(message, status, `${status} just echoes the enum`);
    }
  });
});

// The donation status state machine.
//
// tracking-service is the ONLY thing in the system that decides what a
// donation's status is. donation-service sets PENDING_ASSIGNMENT once at
// creation and never touches it again; assignment-engine owns offers, not
// status. One service owning the lifecycle is what stops two services
// disagreeing about a donation's state - a bug that is close to impossible to
// debug once it reaches production.
//
// This module is PURE: no Mongo, no Kafka, no clock. Same reasoning as the
// scoring package in assignment-engine - "is the state machine right?" should
// be answerable by a unit test with no infrastructure.

export const STATUS = Object.freeze({
  PENDING_ASSIGNMENT: 'PENDING_ASSIGNMENT', // created, not yet offered to anyone
  OFFERED: 'OFFERED',                       // offered to a batch, awaiting a response
  ACCEPTED: 'ACCEPTED',                     // an agent claimed it and is collecting
  COLLECTED: 'COLLECTED',                   // picked up - terminal success
  UNASSIGNED: 'UNASSIGNED',                 // nobody found; queued for retry
  CANCELLED: 'CANCELLED',                   // withdrawn by the donor - terminal
  EXPIRED: 'EXPIRED',                       // passed its best-before - terminal
});

// Terminal states never change again. Guarding this is not pedantry: a
// redelivered donation.assigned arriving after a donation has been collected
// would otherwise move a finished donation back to OFFERED and re-notify
// agents about food that is already gone.
export const TERMINAL = Object.freeze([STATUS.COLLECTED, STATUS.CANCELLED, STATUS.EXPIRED]);

export const isTerminal = (status) => TERMINAL.includes(status);

// Which transitions are legal.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Every event about one donation is keyed
// by donationId, so events on the SAME topic arrive in order. But these events
// live on DIFFERENT topics - donation.assigned and donation.accepted are
// separate partitions consumed at independent speeds. There is no ordering
// guarantee between them, so `accepted` can genuinely be processed before
// `assigned` for the same donation.
//
// The state machine is what makes that harmless: an out-of-order `assigned`
// arriving after `accepted` is simply not a legal transition, and is recorded
// in the timeline without touching the status.
const TRANSITIONS = Object.freeze({
  [STATUS.PENDING_ASSIGNMENT]: [
    STATUS.OFFERED,
    STATUS.UNASSIGNED,
    // Straight to ACCEPTED covers exactly the out-of-order case above.
    STATUS.ACCEPTED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
  ],
  [STATUS.OFFERED]: [
    STATUS.ACCEPTED,
    // A re-offer after a timeout: still OFFERED, but a new round.
    STATUS.OFFERED,
    STATUS.UNASSIGNED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
  ],
  [STATUS.ACCEPTED]: [
    STATUS.COLLECTED,
    // An agent can accept and then fail to show up, which puts the donation
    // back on the market rather than losing it.
    STATUS.OFFERED,
    STATUS.UNASSIGNED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
  ],
  [STATUS.UNASSIGNED]: [
    // Retryable: agents come online, and the donation is offered again.
    STATUS.OFFERED,
    STATUS.ACCEPTED,
    STATUS.UNASSIGNED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
  ],
  [STATUS.COLLECTED]: [],
  [STATUS.CANCELLED]: [],
  [STATUS.EXPIRED]: [],
});

export function canTransition(from, to) {
  if (!from) return true; // a donation with no status yet can start anywhere
  if (!STATUS[to]) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

// What each event does to the status.
//
// `null` means "record it in the timeline but do not change the status" - which
// is the right answer more often than it looks. A rejection by one agent is
// real history worth keeping, but the donation is still OFFERED to the others.
export const EVENT_EFFECTS = Object.freeze({
  'donation.assigned': STATUS.OFFERED,
  'donation.accepted': STATUS.ACCEPTED,
  'donation.collected': STATUS.COLLECTED,
  'donation.unassigned': STATUS.UNASSIGNED,
  // One agent saying no does not change the donation's state; the others are
  // still deciding.
  'donation.rejected': null,
  // A timeout means the current offer lapsed. The engine is already re-scoring,
  // so the donation stays OFFERED rather than flickering back and forth.
  'donation.timeout': null,
});

/**
 * Decide what one event should do.
 *
 * Returns { nextStatus, changed, reason } - never throws, because an event that
 * cannot be applied is a normal occurrence in an at-least-once event system,
 * not an error condition.
 */
export function applyEvent(currentStatus, eventType) {
  const target = EVENT_EFFECTS[eventType];

  if (target === undefined) {
    return { nextStatus: currentStatus, changed: false, reason: 'UNKNOWN_EVENT' };
  }
  if (target === null) {
    return { nextStatus: currentStatus, changed: false, reason: 'TIMELINE_ONLY' };
  }
  if (isTerminal(currentStatus)) {
    // The most important guard here. Without it a redelivered event could
    // resurrect a collected donation.
    return { nextStatus: currentStatus, changed: false, reason: 'ALREADY_TERMINAL' };
  }
  // Checked BEFORE legality, deliberately. A donation already in the target
  // status means a redelivered event - which is routine in an at-least-once
  // system, not an anomaly. Reporting it as ILLEGAL_TRANSITION would log a
  // warning for every ordinary Kafka redelivery and train anyone reading the
  // logs to ignore the warnings that do matter.
  //
  // OFFERED is the exception: a second offer really is a new round.
  if (currentStatus === target && target !== STATUS.OFFERED) {
    return { nextStatus: currentStatus, changed: false, reason: 'NO_CHANGE' };
  }
  if (!canTransition(currentStatus, target)) {
    return { nextStatus: currentStatus, changed: false, reason: 'ILLEGAL_TRANSITION' };
  }

  return { nextStatus: target, changed: true, reason: 'OK' };
}

// Donor-facing wording. The status codes are for machines; a donor waiting on a
// collection wants to know what is happening, not read an enum.
export const DONOR_MESSAGE = Object.freeze({
  [STATUS.PENDING_ASSIGNMENT]: 'Received. Looking for a collection agent.',
  [STATUS.OFFERED]: 'Nearby agents have been asked to collect this.',
  [STATUS.ACCEPTED]: 'An agent is on the way.',
  [STATUS.COLLECTED]: 'Collected. Thank you.',
  [STATUS.UNASSIGNED]: 'No agent available yet. Still trying.',
  [STATUS.CANCELLED]: 'Cancelled.',
  [STATUS.EXPIRED]: 'This donation passed its best-before time.',
});

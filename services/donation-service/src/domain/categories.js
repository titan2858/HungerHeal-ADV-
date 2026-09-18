// The fixed set of food categories (docs/PLAN.md section 2).
//
// Each service keeps its own copy rather than importing a shared package: the
// deliberate microservice tradeoff - a little duplication buys independent
// deployability. The set is fixed by design, so it does not drift.
export const FOOD_CATEGORIES = Object.freeze([
  'COOKED_PREPARED',
  'PERISHABLE_RAW',
  'BAKERY',
  'PACKAGED_NON_PERISHABLE',
  'BEVERAGES',
]);

// Urgency per category. Recorded here because it is a property OF the food,
// but note what it is not: urgency is deliberately NOT a term in the scoring
// formula. It controls two separate things in later phases:
//   1. how long an agent has to respond before the offer times out
//   2. how fast the search radius expands when nobody is found
// Adding it as a 5th additive score term would let a high-urgency donation
// outrank a much closer agent, which is backwards - urgency should change the
// deadline, not who is best suited.
export const CATEGORY_METADATA = Object.freeze({
  COOKED_PREPARED: { urgency: 'HIGH', transport: 'INSULATED_REQUIRED' },
  PERISHABLE_RAW: { urgency: 'HIGH', transport: 'COOLING_PREFERRED' },
  BAKERY: { urgency: 'MEDIUM', transport: 'NONE' },
  PACKAGED_NON_PERISHABLE: { urgency: 'LOW', transport: 'NONE' },
  BEVERAGES: { urgency: 'LOW_MEDIUM', transport: 'NONE' },
});

export const QUANTITY_UNITS = Object.freeze(['SERVINGS', 'KG', 'ITEMS', 'LITRES']);

// The lifecycle of a donation.
//
// donation-service only ever sets PENDING_ASSIGNMENT (at creation). Every other
// transition is driven by events and owned by tracking-service in Phase 7 -
// which is why there is no "update status" endpoint here. One service owning
// the lifecycle is what stops two services disagreeing about a donation's state.
export const DONATION_STATUSES = Object.freeze([
  'PENDING_ASSIGNMENT', // created; assignment-engine has not matched it yet
  'OFFERED',            // offered to the top-scored agents, awaiting a response
  'ACCEPTED',           // an agent claimed it
  'COLLECTED',          // picked up - terminal success
  'UNASSIGNED',         // no agent found anywhere; queued for retry
  'CANCELLED',          // withdrawn by the donor - terminal
  'EXPIRED',            // passed its best-before without collection - terminal
]);

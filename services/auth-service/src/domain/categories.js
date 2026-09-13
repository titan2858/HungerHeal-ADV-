// The fixed set of food categories the whole system is built against.
//
// Each service keeps its own copy of this enum rather than importing a shared
// package: that is the deliberate microservice tradeoff - a little duplication
// buys independent deployability, so donation-service can ship without
// rebuilding auth-service. The set is fixed by design (docs/PLAN.md section 2),
// so it does not drift in practice.
//
// Transport/urgency columns live with the scoring code in assignment-engine
// (Phase 5); here we only need the valid values an agent may declare.
export const FOOD_CATEGORIES = Object.freeze([
  'COOKED_PREPARED',          // meals, curries, rice - insulated transport required, high urgency
  'PERISHABLE_RAW',           // dairy, produce, meat - cooling preferred, high urgency
  'BAKERY',                   // bread, pastries - no special transport, medium urgency
  'PACKAGED_NON_PERISHABLE',  // canned goods, grains - no special transport, low urgency
  'BEVERAGES',                // juices, bottled water - low/medium urgency
]);

export const VEHICLE_TYPES = Object.freeze([
  'BICYCLE',
  'MOTORCYCLE',
  'CAR',
  'VAN',
]);

// A new agent has no completed pickups, so it has no real rating. Seeding a
// neutral 3.5/5 rather than 0 keeps new agents competitive in scoring instead
// of locking them out of every assignment they would otherwise win.
export const DEFAULT_AGENT_RATING = 3.5;

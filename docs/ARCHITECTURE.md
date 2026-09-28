# HungerHeal — architecture and the decisions behind it

The technical companion to [DEMO.md](DEMO.md). This is the "why", with the
tradeoffs stated rather than glossed.

For interview preparation, [INTERVIEW.md](INTERVIEW.md) turns all of this into
150 questions with answers.

**The problem:** the previous version required an **admin to manually assign
every donation to a collection agent**. A human deciding who collects what,
based on proximity and availability. It does not scale, and it is worst exactly
where it matters most — perishable food waiting on someone to look at a screen.

**The replacement:** an automated multi-parameter matching engine. No human
anywhere in the assignment path.

---

## The system

```
                    ┌──────────────┐
   browser ────────▶│   frontend   │  nginx :8080
                    └──────┬───────┘
                           │ /api  (same origin — no CORS, no service ports)
                    ┌──────▼───────┐
                    │ api-gateway  │  :4000 — JWT verified once at the edge
                    └──────┬───────┘
      ┌──────────┬─────────┼──────────┬───────────┬────────────┐
      ▼          ▼         ▼          ▼           ▼            ▼
    auth     donation   geocoding  agent-loc   tracking    notification
   (Mongo)    (Mongo)   (Redis $)  (Redis GEO)  (Mongo)      (Mongo)
                 │                     │           ▲             ▲
                 │ donation.created    │           │             │
                 ▼                     │           │             │
         ┌───────────────────────────┐ │           │             │
         │    assignment-engine (Go) │◀┘           │             │
         │  GEOSEARCH → score → top3 │             │             │
         └───────┬───────────────────┘             │             │
                 │ donation.assigned / .accepted / .unassigned   │
                 └──────────────────────────────────┴────────────┘
                                   │
                                   ▼
                           analytics (Cassandra)
```

Everything between services is **Kafka**. No service calls another for an event.
The one deliberate exception is documented below.

---

## The scoring algorithm

The heart of it. Every term normalised to 0–1 **before** weighting:

```
score = 0.35 × distance      (1 − distance/radius)
      + 0.25 × categoryFit   (compatibility matrix, floor 0.35)
      + 0.20 × load          (1/(1+pendingPickups))
      + 0.15 × rating        (rating/5)
```

**Why normalise first:** distance is in kilometres, load is a count, rating is
out of five. Combined raw, whichever had the largest numeric range would
dominate regardless of the weight written beside it.

**Why these weights:** distance decides whether food arrives while it is still
worth eating. Category fit second, because a close agent who cannot keep food at
temperature delivers something nobody can serve. Load exists so donations spread
across agents instead of stacking on whoever is nearest — the same reason a
ride-hailing app does not hand you five rides at once. Rating is smallest: it is
the least direct evidence about *this* pickup, and over-weighting it would
entrench early winners and starve new agents of the work they need to build a
record.

**They are hand-picked heuristics, not learned.** There was no accept/reject
history to learn from. Phase 11 now collects exactly that (`acceptanceRate` per
agent), so v2 could fit them with logistic regression or a ranking model. Saying
"these are tuned" would be false.

### The compatibility matrix encodes two ideas

| | Cooked | Perishable | Bakery | Packaged |
|---|---|---|---|---|
| Insulated + refrigerated | 1.00 | 1.00 | 0.70 | **0.55** |
| Insulated only | 1.00 | 0.75 | 0.75 | **0.60** |
| Neither | **0.40** | 0.45 | 1.00 | 1.00 |

**Capability** is obvious. **Specialisation** is the interesting one: an agent
*with* an insulated box scores **lower** on dry goods than one without. That
looks backwards until you consider the alternative — specialised agents would
win everything, and the one hot meal that genuinely needs an insulated box would
find them all busy carrying tins.

Nothing is zero. A transport mismatch scoring 0 would make every candidate score
0 in an area with no equipped agents, and the ranking would collapse into noise.

### Urgency is deliberately NOT a fifth term

It says nothing about which agent is better *suited*. As a score term it would
let an urgent donation outrank a much closer agent, which is backwards.

It sets **time** instead: a 90-second response window for hot food vs 5 minutes
for tins, and radius ladders that differ in shape — urgent food jumps
5→12→25→50km because an agent 25km away who says yes now beats a perfect match
found after four patient rounds.

### Hard filters, not penalties

Category eligibility and availability **exclude** a candidate before scoring. A
penalty only lowers a score; it does not remove someone. In the smoke test the
*closest agent of all* carried only packaged goods — a penalty would still have
let them win.

---

## The decisions worth defending

### Why Kafka rather than HTTP between services

A donation is never lost because a downstream service is down. donation-service
appends `donation.created` and is finished; if the engine is restarting, the
event waits.

It also made adding services free. **tracking-service, notification-service and
analytics-service were each added without changing a single line of any existing
service** — a new consumer group receives the whole stream.

The most persuasive demonstration: analytics-service, written last, consumed
`fromBeginning` and reconstructed **133 events across four days**, including days
before it existed. Nobody wrote a migration. The log *was* the migration.

### At-least-once delivery, and the two halves that make it safe

Kafka redelivers a message if a consumer crashes after doing the work but before
committing its offset. Without a guard, a donation gets assigned twice and six
agents are notified for one meal.

Both halves are required and both are built:

1. **Consumers process then commit** — a crash redelivers rather than loses.
2. **Consumers deduplicate** on `eventId` via Redis `SETNX`, namespaced per
   service so three consumers each get their own turn.

With one subtlety: the dedup marker is set *before* the work, so a **failure
must release it**, or the retry skips a donation that was never processed.

### The dual-write problem

Creating a donation means writing to Mongo *and* publishing to Kafka, with no
transaction spanning both. A crash in between leaves a donation nothing
downstream ever hears about — the donor sees success and their food is never
collected.

Solved with a light **transactional outbox**: save with `eventPublished: false`
first, publish second, sweeper retries every 15s. Verified by stopping Kafka,
posting a donation (still 201), restarting, and watching the sweeper publish it
under the request's *original* traceId.

### Redis, doing four different jobs

| Use | Why Redis specifically |
|---|---|
| `GEOSEARCH` for nearby agents | Sub-millisecond radius query vs loading every agent and computing distance |
| Load counters | `INCR`/`DECR` are atomic — concurrent updates cannot be lost |
| Geocode cache | An address does not move; a 30-day TTL makes the cache pay for itself |
| Dedup + claim lock | `SETNX` answers "am I first?" atomically |

**A geo set cannot expire its members.** A sorted set has no per-member TTL, so
an agent who closes the app would stay on the map forever and keep receiving
offers that time out. Solved with a separate heartbeat key that *does* expire,
checked on every read, plus a reaper goroutine to stop the set growing.

### Why Go for two services

`agent-location-service` handles the highest-frequency write — every active
agent, every 20 seconds, forever. `assignment-engine` scores candidates and
notifies the top three in parallel.

The images are also **30MB against 286MB** for the Node services, via a
multi-stage build that ships the binary rather than the toolchain.

### Why Cassandra for analytics

MongoDB holds *current state* and answers "what is true now?" well. This is
"what happened, in order, over months?" with append-only writes — a different
shape.

**The cost, stated:** you must know your queries before designing your tables.
`donation_events` and `events_by_day` hold **the same events twice**, because
the first cannot answer "what happened today?" without scanning every partition.
In a relational database that is a normalisation error; here it is the design.

### The one place a service reads another's data

`assignment-engine` reads the Redis keys `agent-location-service` writes, rather
than calling its HTTP API. The plan specifies it, and the reason is the hot
path: an HTTP hop would add latency to a query Redis answers in under a
millisecond, on the one path where latency costs food quality.

**The cost is real:** the key layout is now a contract between two services.
Documented in both, and asserted by both smoke suites.

---

## Two places the implementation departs from the spec

Both documented in code.

**The distance term.** The plan writes `1/normalized_distance`. Taken literally
that is unbounded — an agent at the pickup point scores infinity and the other
three terms stop mattering — and it contradicts the same document's instruction
to normalise every term to 0–1. Implemented as a linear falloff, which is what
that instruction actually asks for.

**The weights sum to 0.95, not 1.0.** 0.35 + 0.25 + 0.20 + 0.15. The plan lists
those exact values, so they are kept rather than quietly rescaled. It changes no
ranking — every candidate is scaled by the same constant — so it only matters
when a human reads a score, which is why the UI states `/ 0.95`.

---

## Testing

**242 unit tests, 333 smoke checks, 13 suites.**

The split is deliberate:

- **Unit tests need no infrastructure.** The scoring package and the status
  state machine import nothing but the standard library, so a failure means the
  *algorithm* is wrong — never that a broker was slow. The entire scoring
  package was written and its 35 tests passed with Docker stopped.
- **Smoke tests drive the real stack**, including reading events back out of
  Kafka, asserting on raw Redis structures, and waiting out an actual
  90-second timeout.

### Bugs the tests caught

| Bug | Why it mattered |
|---|---|
| Ungeocoded donations 500'd | Mongoose wrote `location: {type:'Point'}` with no coordinates; 2dsphere rejects it |
| A skipped Kafka publish reported success | The outbox would never have retried those donations |
| Failed uploads leaked files | Multer writes before validation, which bypasses the controller |
| **Dedup read the Kafka header** | A replay carries no headers → the donation was assigned twice |
| **An idempotency check passed vacuously** | A broken replay command meant it tested nothing |
| Gateway stripped its own prefix | `app.use(prefix)` strips it; the rewrite matched nothing |
| A duplicate JSON log key | Log processors may drop or reorder duplicates |
| **An agent invisible to matching** | A stub hash satisfied the "already mirrored" check, so the agent had no categories and was hard-filtered from every donation |

The fifth one is worth dwelling on: the test *reported success for behaviour it
never exercised*, which is worse than no test. It now asserts the replay itself
succeeded before drawing any conclusion.

### The bug the tests did NOT catch

The last row was found **by using the app**, with every test passing. Two
endpoints wrote the same Redis hash, and every test set an agent up in the same
order — location first — so nothing ever exercised the other order, which was
the one that broke. The suite had encoded the happy path's *sequencing* as
though it were the only sequencing.

Where two callers write one key, the tests have to cover **both orders**. Full
write-up in [13](13-bugfix-capability-mirror.md).

---

## What is honestly not done

- **Notifications are in-app only.** No push, SMS or email. `priority: HIGH` is
  carried on the ones that would justify waking a phone; nothing delivers them.
- **No dead-letter topic.** An unparseable message is committed and logged,
  because leaving it would block the partition forever.
- **The weights are not learned.** The data to fit them is now being collected.
- **`vehicleType` is captured but unscored** — it needs a capacity model the
  plan does not define, and inventing thresholds would be worse than the gap.
- **Distance is straight-line**, not travel time. A routing API would be more
  accurate and would add a per-candidate network call to the hot path.
- **donation-service's own `status` field goes stale.** tracking-service is the
  authority and the UI reads it; the stale field remains, asserted by a test so
  it is not forgotten.
- **No cancel-by-donor.** `CANCELLED` exists in the state machine and is tested;
  nothing publishes it.
- **Cassandra has no TTL.** History grows forever. A real deployment would set
  one or archive.
- **Old tracking records lack `title`/`quantity`**, added in Phase 9. A backfill
  is possible — reset the consumer group and replay, which the idempotency makes
  safe — and has not been done because they are test records.

---

## Phase-by-phase documentation

Each phase has its own document with the reasoning at the time:

| | |
|---|---|
| [00](00-phase0-infrastructure.md) | Infrastructure; Kafka and Redis explained from zero |
| [01](01-phase1-auth-service.md) | Auth, JWT, bcrypt |
| [02](02-phase2-donation-service.md) | Kafka producing, and the outbox pattern |
| [03](03-phase3-geocoding-and-map.md) | Redis caching concepts, the Leaflet picker |
| [04](04-phase4-agent-location-service.md) | Redis Geo, the heartbeat/reaper pattern |
| [05](05-phase5-assignment-engine.md) | **The scoring algorithm** |
| [06](06-phase6-offer-lifecycle.md) | Idempotency, the claim race, timeouts |
| [07](07-phase7-tracking-and-notifications.md) | The status state machine |
| [08](08-phase8-agent-ui.md) | The agent UI and the offer countdown |
| [09](09-phase9-donor-ui.md) | The donor dashboard |
| [10](10-phase10-monitoring.md) | **Why the monitoring view has no assign button** |
| [11](11-phase11-analytics-cassandra.md) | Cassandra modelling |
| [12](12-phase12-gateway-and-containers.md) | The gateway |
| [13](13-bugfix-capability-mirror.md) | **A bug every test missed** — two writers, one key, no owner |

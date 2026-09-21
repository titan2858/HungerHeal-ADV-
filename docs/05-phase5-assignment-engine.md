# Phase 5 — assignment-engine (Go)

The matching brain, and the reason this project exists. It replaces the human
admin of the original monolith: a donation appears, and within a second three
suitable agents have been offered it, ranked, with the reasoning recorded.

Go 1.26 + go-redis + kafka-go. Event-driven; **:4005** serves health only.

```bash
docker compose up -d --build assignment-engine
cd services/assignment-engine && go test ./...   # 51 tests, no infrastructure needed
bash scripts/smoke-assignment.sh                 # 26 checks, full chain end to end
```

---

## The build discipline, and why it mattered

The plan is explicit about the order: write the scoring as a **pure function**,
unit-test it with fabricated data, and only then wire in Redis and Kafka.

That is exactly what happened here, and it paid off immediately — **the entire
scoring package was written and its 35 tests were passing while Docker was
stopped.** Not "could have been": Docker Desktop was down at the start of this
phase and the scoring work did not wait for it.

The payoff is not convenience. It is that a failing test means precisely one
thing. When `TestRatingBreaksTiesButDoesNotDominate` failed, the question was
"is the balance between these two weights right?" — not "is Redis stale, is the
consumer group lagging, did the event serialise correctly?". Debugging an
algorithm and a pipeline at the same time is what the separation avoids.

The dependency layering enforces it:

```
scoring/     -> stdlib + domain only.    No Redis. No Kafka. No clock.
engine/      -> depends on INTERFACES.   Tested with fakes.
candidates/  -> Redis.
events/      -> Kafka.
cmd/engine/  -> wires the four together.
```

---

## The scoring formula

```
score = 0.35 × distanceScore      (1 − distance/radius, clamped to 0..1)
      + 0.25 × categoryScore      (compatibility matrix, 0.35..1.0)
      + 0.20 × loadScore          (1/(1+pendingPickups))
      + 0.15 × ratingScore        (rating/5)
```

Every term is normalised to 0..1 **before** its weight is applied. This is what
makes the weights mean anything: distance is in kilometres, load is a count,
rating is out of five. Combined raw, whichever had the largest numeric range
would dominate regardless of the weight written beside it.

### Two places where the implementation departs from the spec's literal text

Both are documented in code, and neither changes the plan's intent.

**1. The distance term.** `docs/PLAN.md` writes it as `1/normalized_distance`.
Taken literally that is unbounded — an agent standing at the pickup point scores
infinity and the other three terms can never matter again — and it contradicts
the same document's instruction to normalise every term onto 0..1. The
implementation uses a linear falloff, `1 − distance/radius`, which is what that
instruction actually asks for: bounded, closer strictly better, and the 0.35
weight still meaning 35%.

**2. The weights sum to 0.95, not 1.0.** 0.35 + 0.25 + 0.20 + 0.15 = 0.95. The
plan lists those exact values, so they are kept exactly as written rather than
quietly rescaled. **It changes no ranking** — every candidate is scaled by the
same constant — so it only matters when a score is shown to a human. Hence
`MaxPossibleScore` and a `scorePercent` field on the breakdown, so "0.81"
does not invite the unanswered question "out of what?".

### The compatibility matrix

A 0–1 scale, never binary. If a transport mismatch scored zero, a donation in an
area where nobody owns an insulated box would score every candidate at zero and
the ranking would collapse into noise — the engine would pick effectively at
random among people it had declared equally unsuitable. The floor is **0.35**.

|  | Cooked | Perishable raw | Bakery | Packaged | Beverages |
|---|---|---|---|---|---|
| **Insulated + refrigerated** | 1.00 | 1.00 | 0.70 | 0.55 | 0.70 |
| **Refrigerated only** | 0.80 | 1.00 | 0.75 | 0.60 | 0.75 |
| **Insulated only** | 1.00 | 0.75 | 0.75 | 0.60 | 0.75 |
| **Neither** | 0.40 | 0.45 | 1.00 | 1.00 | 0.95 |

Two principles are encoded, and the second is easy to miss:

**Capability** — hot food needs insulation, raw perishables want cooling.

**Specialisation** — an agent *with* an insulated box scores **lower** on dry
packaged goods than one without. That looks backwards until you consider the
alternative: if specialised agents always outranked plain ones they would win
everything, and the one cooked meal that genuinely needs an insulated box would
find them all busy carrying canned beans.

The smoke test proves both directions:

```
cooked food:  equipped(0.809) beat barenear(0.735)   -- equipment won over 1.1km
tinned goods: the plain agent beat the refrigerated van at the same distance
```

### Urgency is not a scoring term

It would be easy to add as a fifth weighted term, and it would be wrong. Urgency
says nothing about which agent is *better suited* — a meal being urgent does not
make a distant agent with no insulated box a better choice. As a score term it
would let a high-urgency donation outrank a much closer agent, which is
backwards.

What urgency actually changes is **time**:

| Category | Urgency | Response window | Radius ladder |
|---|---|---|---|
| Cooked, perishable raw | HIGH | **90s** | 5 → 12 → 25 → 50 km |
| Bakery, beverages | MEDIUM | 3 min | 5 → 10 → 20 → 35 km |
| Packaged | LOW | 5 min | 5 → 8 → 12 → 20 km |

The ladders differ in *shape*, not just size. Urgent food jumps far and fast —
an agent 25km away who says yes now beats a perfect match found after four
patient rounds. Tinned goods widen gently, because there is time to find a
genuinely well-suited nearby agent rather than sending someone across the city.

An unknown category defaults to **HIGH**. If that guess is wrong the cost is a
hurried reassignment; the opposite mistake lets food spoil while the system
waits patiently.

---

## Hard filters versus score penalties

Three things exclude a candidate outright, before any scoring:

- they do not handle this food category
- they have marked themselves unavailable
- they already declined or timed out on this donation

The distinction matters, and the smoke test demonstrates why. The
**closest agent of all** carried only packaged goods. A score penalty would
still have let them win — they were nearest, and a penalty only reduces a score,
it does not remove a candidate. Exclusion is the only correct handling for
"cannot do this at all".

Compare with `hasInsulatedTransport`, which *is* a scoring input, because it is a
matter of degree: food arriving lukewarm is worse than ideal but far better than
food not collected.

---

## The events

### `donation.assigned`

Published when agents are found. Note what the name does **not** mean: nobody
has accepted yet. The donation belongs to whichever offered agent accepts first,
and Phase 6 arbitrates that race with a Redis lock.

```json
{
  "donationId": "6ab16116...",
  "traceId": "phase5-smoke-1790009619",
  "offers": [
    { "rank": 1, "agentId": "...", "score": 0.8095,
      "breakdown": { "distanceScore": 0.7273, "categoryScore": 1,
                     "loadScore": 1, "ratingScore": 0.7,
                     "weightedDistance": 0.2545, "weightedCategory": 0.25,
                     "weightedLoad": 0.2, "weightedRating": 0.105,
                     "total": 0.8095, "scorePercent": 85.21 } }
  ],
  "searchRadiusKm": 5, "radiusAttempts": 1,
  "candidatesFound": 5, "candidatesEligible": 4,
  "responseTimeoutSeconds": 90, "urgency": "HIGH"
}
```

**The breakdown travels with the offer.** This is a product requirement, not
debug scaffolding: Phase 10's monitoring view must show *why* an agent was
chosen, and "the system decided" is not an acceptable answer to a donor whose
food went to the wrong person. Recomputing it later would read agent state that
has since changed, so the reasoning is captured at decision time. The smoke test
asserts the weighted parts sum exactly to the total — an explanation that does
not add up is a fiction.

The search story (`radiusAttempts`, `candidatesFound`, `candidatesEligible`)
lets a human tell *"the best agent in the city"* from *"the only agent we could
find after widening three times"*.

### `donation.unassigned`

Published when nobody can be found — **never silently dropped**, per the plan.
The reason is a machine-readable code, because the donor-facing message and the
retry policy both branch on it:

| Reason | Meaning | Retryable |
|---|---|---|
| `NOT_GEOCODED` | No coordinates, so no search is possible | **no** — waiting will not geocode it |
| `NO_AGENTS_FOUND` | Nobody online within the widest radius | yes — agents come online continuously |
| `NO_ELIGIBLE_AGENTS` | Agents nearby, but none carry this category | yes |
| `ALL_AGENTS_EXHAUSTED` | Everyone eligible has declined (Phase 6) | yes |

The distinction between the middle two matters: "nobody is online here" is worth
retrying in ten minutes; "three agents are nearby but none carry cooked food"
needs a different answer entirely.

---

## Consuming Kafka — the first consumer in the project

Every service so far has only produced. Three details are load-bearing:

**Fetch, process, then commit — in that order.** The offset advances only after
the work succeeded, so a crash mid-processing redelivers the message rather than
losing the donation. That is at-least-once delivery working as intended, and is
precisely why consumers must be made idempotent in Phase 6.

**A lookup failure is an error, not an answer.** If Redis is down, the engine
returns an error and does *not* commit. Treating it as "no agents found" would
publish a false answer **and** mark the donation handled — permanently losing a
donation that was perfectly placeable. There is a test pinning this.

**Poison messages are committed, loudly.** A message that cannot be parsed will
never parse, and leaving it uncommitted blocks the partition forever. It is
logged and skipped. The proper answer is a dead-letter topic to hold it for
inspection; that is a real gap, recorded rather than pretended away.

The consumer group is what makes the engine horizontally scalable: run three
instances and Kafka gives each one a partition of `donation.created`, sharing
the work with no coordination between them.

---

## Reading Redis directly — a deliberate exception

Everywhere else, one service never reads another's data store. Here
assignment-engine reads the exact keys `agent-location-service` writes, and the
plan specifies it: the engine finds agents "via Redis GEOSEARCH".

The reasoning is the hot path. Going through agent-location-service's HTTP layer
would add a network hop, JSON encode/decode, and that service's availability to
a query Redis already answers in under a millisecond.

**The cost is real and worth naming:** the key layout is now a contract between
two services. If agent-location-service renames `agent:<id>:caps`, this breaks
silently. It is documented in both places and asserted by both smoke suites.

One pipeline fetches every candidate's heartbeat, capabilities and load — 3
round trips for 100 candidates instead of 300.

---

## Testing

**51 Go tests, none of which need infrastructure.**

- **35 scoring tests** — fabricated numbers only. They pin the normalisation
  bounds, each term's curve, the compatibility matrix in both directions, the
  hard filters, ranking determinism, and two realistic Bengaluru scenarios that
  read like the actual situation rather than isolated numbers.
- **16 engine tests** — fakes for Redis and Kafka. They cover radius expansion
  (including that it stops as soon as someone is found), the two different
  "nobody found" reasons, that a Redis failure surfaces as an error rather than
  a wrong answer, and that the traceId propagates.

**26 smoke checks** then drive the real chain: five agents placed on a real map,
a donation posted over HTTP, and the resulting `donation.assigned` **read back
out of Kafka** and inspected — which agent ranked first, and whether the
arithmetic on the event explains it.

### Three smoke failures, all of which were the test being wrong

Worth recording, because in each case the engine did the right thing:

1. I asserted 3 offers when only 2 agents handled cooked food — the third was
   correctly filtered. Fixed by placing more eligible agents, which also made
   the top-3 cap meaningful.
2. The same, for ranks `[1,2]`.
3. In the tinned-goods test the packaged-only agent from an earlier step was
   *also* plain and *closer*, so it legitimately won. The test had to remove it
   to compare the one thing it meant to compare.

---

## Deliberately Phase 6, not this phase

The plan sequences these into the next phase, and they are real gaps until then:

- **Idempotency.** The engine is not yet deduplicating on `eventId`. A
  redelivered `donation.created` would today produce a second
  `donation.assigned`. The fix is the Redis `SETNX` dedup from Phase 0's notes.
- **Response timeouts and re-scoring.** The timeout is *computed* and carried on
  the event, but nothing is counting it down yet. tracking-service starts that
  timer in Phase 7, and the `donation.timeout` → re-score loop closes in Phase 6.
- **The accept race.** Three agents are offered in parallel; nothing yet stops
  two of them accepting. The Redis lock that arbitrates it is Phase 6.
- **Excluding agents who already declined.** `RankAgents` takes an `excluded`
  set and it is unit-tested, but nothing populates it until there are timeout
  events to populate it from.

## Honest limitations of the algorithm itself

- **The weights are hand-picked heuristics**, not learned. There is no accept
  or reject history to learn from yet. A v2 could fit them with logistic
  regression or a learning-to-rank model against "did this agent accept, and how
  fast did they collect?".
- **`vehicleType` is captured and displayed but not scored.** Scoring it
  properly needs a capacity model — a bicycle cannot take 40 servings — and the
  plan does not define one.
- **Distance is straight-line**, as returned by Redis. Real travel time depends
  on roads and traffic. A routing API would be more accurate and would add a
  per-candidate network call to the hot path.

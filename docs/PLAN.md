# HungerHeal — Microservices Rebuild (Context for Claude Code)

## 0. Background

HungerHeal is a food donation and distribution platform. A monolithic MERN
version already exists (React + Express + MongoDB, single backend, JWT auth,
Multer image uploads, OpenCage geocoding, Leaflet map). In that version, an
**admin manually assigns each donation to a collection agent** based on
proximity/availability — a human bottleneck that doesn't scale and is
especially bad for perishable food.

**This is a from-scratch rebuild** of the same product idea, not a migration
of the old codebase. Same core concept (donors list food, agents collect and
deliver it), entirely new architecture: event-driven microservices, with the
manual admin-assignment step replaced by an automated multi-parameter
matching engine.

**Primary goals, in order:**
1. Fully automate donation → agent assignment (no manual admin step at all).
2. Build something interview-worthy: Go, Kafka, Redis, microservices,
   (optionally) Cassandra, as concrete talking points with real reasoning
   behind each choice — not buzzwords.
3. Ship a working, demoable system, phase by phase, rather than a big-bang
   rewrite.

**Builder's starting knowledge:** Zero prior experience with Kafka or Redis.
Claude Code (or whichever assistant works from this doc) should explain what
each of these tools is and how it works *at the point it's introduced in the
build*, not just write code silently — this is a deliberate learning goal,
not only a delivery goal.

---

## 1. Final service list

| # | Service | Language | Responsibility |
|---|---|---|---|
| 1 | `auth-service` | Node.js/Express | Signup/login for donor + agent, JWT issuing, bcrypt password hashing |
| 2 | `donation-service` | Node.js/Express | Create/list/view donations, image upload (Multer), category field, publishes `donation.created` |
| 3 | `geocoding-service` | Node.js/Express | Wraps OpenCage API, caches address→lat/lng in Redis |
| 4 | `agent-location-service` | Go | Agents push live location + capabilities (vehicle type, insulated transport, category support) into Redis Geo |
| 5 | `assignment-engine` | Go | Core matching "brain" — multi-parameter scoring, auto-assign, parallel notify, auto-reassign on timeout |
| 6 | `tracking-service` | Node.js/Express | Owns donation status lifecycle, manages accept/response timeout timers |
| 7 | `notification-service` | Node.js/Express | Alerts agents on assignment, alerts donors on status change |
| 8 | `analytics-service` | Go or Express (optional) | Consumes all events, writes to Cassandra, powers stats dashboards |
| 9 | `api-gateway` | Node.js/Express or Go | Single entry point for the frontend, verifies JWT once, routes to services |
| 10 | `frontend` | React (Vite) | Donor UI, Agent UI, optional thin read-only monitoring view |

**No manual admin-assignment panel.** If any admin/monitoring view exists, it
is strictly **read-only** — shows what the algorithm decided and *why*
(score breakdown), with no assign/reassign controls.

**Per-service data ownership:**
- MongoDB → `auth-service` (users), `donation-service` (donations)
- Redis → agent live geolocation (`GEOADD`/`GEORADIUS`), agent capability/load
  data, geocoding cache
- Kafka → event bus connecting all services
- Cassandra (optional) → long-term event history for `analytics-service`

---

## 2. The core algorithm — multi-parameter assignment

This is the actual replacement for the human admin, and the centerpiece of
the whole project.

### Food categories (fixed set to build against)

| Category | Examples | Transport need | Urgency |
|---|---|---|---|
| Cooked/Prepared | Meals, curries, rice dishes | Insulated bag/box required | High |
| Perishable Raw | Dairy, fresh produce, meat | Cooling preferred | High |
| Bakery | Bread, pastries | None special | Medium |
| Packaged/Non-perishable | Canned goods, packets, grains | None | Low |
| Beverages | Juices, bottled water | None (unless dairy-based) | Low–Medium |

Agents declare, at registration, which categories/transport types they can
handle (a simple multi-select, e.g. "has insulated transport: yes/no").

### Scoring formula

Each candidate agent (found via Redis `GEORADIUS` around the donation's
location) gets a score:

```
score = 0.35 * (1 / normalized_distance)
      + 0.25 * category_compatibility      // 0–1 scale, not binary
      + 0.20 * (1 / (1 + current_load))
      + 0.15 * normalized_rating
```

- **Normalize every term to 0–1 before applying weights** — raw distance,
  load, and rating are on very different scales, so combining them
  unnormalized lets one term silently dominate regardless of its weight.
- **Distance (0.35):** closer agent = faster pickup. Biggest factor.
- **Category/transport compatibility (0.25):** not binary pass/fail — a
  compatibility matrix (e.g. insulated-transport agent scores high on
  cooked food, medium on dairy, low on dry goods) so a strict mismatch
  doesn't zero out every candidate.
- **Current load (0.20):** `1 / (1 + current_load)` — an agent with 0
  pending pickups scores 1.0, with 3 pending scores 0.25. Tracked as a
  live counter in Redis: **increment** on accepted assignment, **decrement**
  on "Collected"/"Rejected". Exists to avoid stacking every donation onto
  one "best" agent while others sit idle — same reasoning as why a
  ride-hailing app doesn't send you 5 rides before you finish the first.
- **Rating (0.15):** historical reliability. New agents with no history get
  a neutral default (e.g. 3.5/5) rather than 0, so they aren't unfairly
  locked out.
- **Urgency is NOT a 5th additive score term.** It's handled separately by
  controlling (a) how long an agent has to respond, and (b) how fast the
  search radius expands if no agent is found. Cooked/perishable → short
  timeout (~90s); packaged/non-perishable → longer timeout (~3–5 min).

Weights above are **hand-picked defaults with clear reasoning**, not
empirically tuned — explicitly frame this as a v1 heuristic in any writeup,
with "v2 could learn weights from historical accept/reject data via logistic
regression or a ranking model" as the honest next step.

### Assignment + notification flow

1. Donation created → find agents in radius (start ~5km; auto-expand to
   10km, 20km, etc. if none found).
2. Score all candidates with the formula above.
3. **Notify the top 3 scored agents in parallel** (this applies to *all*
   food categories, not just perishable — category only changes the
   timeout window, not whether it's parallel).
4. First agent to accept gets the donation; the other two offers are
   cancelled. Use a Redis lock/flag so two agents can't both accept the
   same donation (race condition).
5. If none of the 3 respond within the timeout window, re-score (excluding
   agents who already declined/timed out) and notify the next batch.
6. If truly no agent is ever found, queue the donation and retry
   periodically, and let the donor know it's still pending — don't let it
   silently disappear.

### Build discipline for this service

Write the scoring math as a **pure, standalone function** first — no Kafka,
no Redis, no network calls, just `ScoreAgent(donation, agent) -> float`.
Unit-test it with fabricated data before wiring it into the real Kafka
consumer / Redis queries. This isolates "is the algorithm correct" from "is
the plumbing correct," which is dramatically easier to debug than finding
both at once inside a live event pipeline.

---

## 3. Event flow (Kafka)

```
donation-service
   │ publishes: donation.created
   ▼
assignment-engine  ──consumes──▶ scores agents ──publishes──▶ donation.assigned (top 3, parallel)
   │                                                              │
   │                                                     ┌────────┴────────┐
   │                                                     ▼                 ▼
   │                                          notification-service   tracking-service
   │                                          (alerts agents)        (status + timeout timer)
   │
   ▼ (on timeout / no response)
publishes: donation.timeout  ──▶ assignment-engine re-scores remaining agents, repeats

agent accepts  ──▶ donation.accepted  ──▶ tracking-service marks in-progress,
                                            increments that agent's load counter
agent marks collected/rejected ──▶ donation.collected / donation.rejected
                                    ──▶ tracking-service updates status,
                                        decrements agent's load counter,
                                        analytics-service logs event (if built)
```

**Kafka consumers must be idempotent.** Kafka is at-least-once delivery: if a
consumer crashes after doing work but before committing its offset, the same
message gets redelivered on restart, which could double-assign a donation or
double-count an agent's load. Fix: before processing an event, check a Redis
key keyed by a unique event ID (`SETNX`) — if it's already set, skip
(already processed); if not, set it and proceed.

---

## 4. Redis — both uses, explicit

1. **Geospatial agent lookup:** `GEOADD` to store agent live location,
   `GEORADIUS` to instantly find all agents within X km — avoids looping
   through every agent computing distance manually as agent count grows.
2. **Caching + counters:** geocoding results (address → lat/lng, avoids
   repeat/rate-limited OpenCage calls), per-agent current-load counters, and
   idempotency keys for Kafka event processing.

---

## 5. Local dev practices (bake these in from day one, not later)

- **`docker-compose` for all infra from Phase 0** — Mongo, Redis, Kafka,
  (Cassandra if built) all spin up with one command. Add each of your own
  services to the same compose file incrementally as they're built. Avoids
  "wait, is Kafka even running?" debugging.
- **Structured logging with a `traceId`/`donationId` from Phase 1 onward** —
  every service logs with this ID so a donation's full journey across
  services can be traced. Viewable live via
  `docker-compose logs -f <service>` (or all services at once); good enough
  for this project's scope — no need for Grafana/Loki unless there's spare
  time.

---

## 6. Build sequence (this is the order to actually follow)

1. **Phase 0 — Setup.** Docker, Node, Go, MongoDB, Redis, Kafka all running
   locally via `docker-compose`. No feature code yet — just prove every
   piece of the stack runs.
2. **Phase 1 — `auth-service`.** Donor + agent signup/login, JWT, bcrypt.
3. **Phase 2 — `donation-service`.** Create/list donations, image upload,
   **category field included from day one** (needed later for scoring).
4. **Phase 3 — `geocoding-service` + map.** OpenCage + Redis caching;
   React Leaflet for pickup location selection.
5. **Phase 4 — `agent-location-service`.** Agent live location + capability
   metadata (vehicle type, insulated transport, categories handled) written
   to Redis.
6. **Phase 5 — `assignment-engine`.** Build the pure `ScoreAgent` function
   first, unit-test it standalone, *then* wire in Redis `GEORADIUS` queries
   and Kafka consumption/publishing. This is the largest, most important
   phase — give it real time.
7. **Phase 6 — Kafka event flow end-to-end.** `donation.created →
   donation.assigned` (parallel top-3 notify), `donation.timeout` →
   re-score loop, idempotency handling.
8. **Phase 7 — `tracking-service` + `notification-service`.** Status
   updates, response timers, agent/donor alerts.
9. **Phase 8 — Agent-side React UI.** Login, live location sharing, view
   assigned donation with response countdown, accept/reject, mark
   collected.
10. **Phase 9 — Donor-side React polish.** Dashboards, donation history,
    stats, styling/animations.
11. **Phase 10 — Optional read-only monitoring view.** List of donations,
    assigned agent, status, and the score breakdown behind each assignment
    — no manual controls.
12. **Phase 11 — Optional `analytics-service` + Cassandra.** Consume all
    events, log to Cassandra, power stats like average time-to-assignment.
13. **Phase 12 — `api-gateway` + Docker polish.** Single entry point for
    the frontend, JWT verified once, everything containerized for a clean
    demo.

---

## 7. Explicitly decided / non-negotiable choices (don't relitigate these)

- No manual admin assignment, at all — full automation is the point.
- Multi-parameter scoring (distance + category + load + rating), not
  distance-only.
- Normalize before weighting.
- Parallel top-3 notify for every category; only the timeout duration
  varies by urgency.
- Idempotent Kafka consumers via Redis-based dedup.
- Pure, unit-tested scoring function before infra wiring.
- `docker-compose` and structured logging from the start, not deferred to
  the end.
- Explain Kafka and Redis concepts as they're introduced during the build —
  the person has zero prior experience with either.

## 8. Open / to decide later

- Exact list of weight values may be revisited once real data exists — the
  above are v1 defaults with stated reasoning, not final/tuned.
- Whether Cassandra/analytics and the read-only monitoring view get built
  at all is time-permitting, not core to the demo.

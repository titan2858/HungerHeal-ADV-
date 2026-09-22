# HungerHeal — Event-Driven Microservices

Food donation and distribution platform. Donors list surplus food; collection
agents pick it up and deliver it.

This is a from-scratch rebuild of an earlier monolithic MERN version. The
defining change: that version required an **admin to manually assign every
donation to an agent**. Here that human step is gone entirely, replaced by an
automated multi-parameter matching engine that scores nearby agents on
distance, food-category/transport compatibility, current workload and rating,
then notifies the top candidates in parallel and reassigns automatically on
timeout.

Full specification: [docs/PLAN.md](docs/PLAN.md).

---

## Running it

Needs Docker Desktop and Node 20+. Nothing else — Go is only needed to run the
Go tests, not to run the services, which build inside Docker.

**First time:**

```bash
cp .env.example .env              # works as-is; see "configuration" below
docker compose up -d --build      # all 11 containers (infra + 7 services)
bash scripts/create-topics.sh     # the 8 Kafka topics
bash scripts/verify-infra.sh      # 6 checks, all should pass

cd frontend && npm install && npm run dev
```

Then open <http://localhost:5173>.

**Every time after that:**

```bash
docker compose up -d              # ~20s to healthy
cd frontend && npm run dev
```

The first build takes a few minutes (it compiles two Go services and installs
five Node services). After that `up -d` is seconds.

**Check everything is healthy** before using it — services report `(healthy)`
only once they have connected to Mongo, Redis and Kafka:

```bash
docker compose ps
```

**Stop:** `docker compose down`, or `docker compose down -v` to also discard
the data (users, donations, tracking history).

### Configuration

`.env.example` works unchanged. Two values are worth knowing about:

- **`JWT_SECRET`** — every service verifies tokens against this, so they must
  all share it. The committed placeholder is fine locally; generate a real one
  with `openssl rand -hex 32` for anything else.
- **`OPENCAGE_API_KEY`** — optional. Left empty, geocoding uses a built-in
  offline geocoder that knows ten Bengaluru landmarks, and the whole stack
  works end to end. Set it (free tier at <https://opencagedata.com/>) for real
  addresses worldwide.

### Trying it out

**A donation is only matched if an agent is on shift within range of it.**
That is the one thing that trips people up: with no agent on shift, a donation
correctly ends up `UNASSIGNED` and the system is working exactly as designed.

You need two sessions, because the login token lives in `localStorage` and one
browser profile holds one session:

1. **A normal window** — sign up as a **donor**.
2. **An incognito window** — sign up as an **agent**, tick a food category, and
   press **Go on shift**. Allow location access when the browser asks.
3. Back in the donor window, post a donation. In the map picker use
   **"Use my location"**, so the pickup is near where the agent's browser says
   they are — otherwise the two are hundreds of kilometres apart and nothing
   matches.
4. Within a few seconds the agent window shows a **collection request with a
   90-second countdown**. Accept it.
5. The donor window shows *"An agent is on the way"* with the agent's phone
   number; the agent's **To collect** list gets the pickup. Mark it collected.

To watch the events behind that, open <http://localhost:8090> (Kafka UI) and
look at `donation.created`, `donation.assigned` and `donation.accepted`. Or
follow one donation across every service:

```bash
docker compose logs | grep <traceId>
```

If you would rather not click through it, the smoke scripts do the whole
journey automatically against the running stack:

```bash
bash scripts/smoke-tracking.sh    # donation -> offered -> accepted -> collected
bash scripts/smoke-donor.sh       # the donor dashboard's data
bash scripts/smoke-lifecycle.sh   # accept races and timeouts (~4 min, waits out a real 90s window)
```

| Service | URL |
|---|---|
| auth-service | <http://localhost:4001> |
| donation-service | <http://localhost:4002> |
| geocoding-service | <http://localhost:4003> |
| agent-location-service | <http://localhost:4004> |
| assignment-engine (offers API) | <http://localhost:4005> |
| tracking-service | <http://localhost:4006> |
| notification-service | <http://localhost:4007> |
| analytics-service *(profile)* | <http://localhost:4008> |
| frontend (Vite dev) | <http://localhost:5173> |
| Kafka UI | <http://localhost:8090> |
| MongoDB | `localhost:27018` (27017 is taken by the local mongod) |
| Redis | `localhost:6379` |
| Kafka (from host) | `localhost:29092` |
| Kafka (inside Docker) | `kafka:9092` |

Stop with `docker compose down`, or `docker compose down -v` to also discard
the data volumes.

---

## Architecture

```
                     ┌──────────────┐
                     │   frontend   │  React + Vite
                     └──────┬───────┘
                            │ JWT verified once
                     ┌──────┴───────┐
                     │ api-gateway  │
                     └──────┬───────┘
        ┌──────────────┬────┴─────┬───────────────┐
        ▼              ▼          ▼               ▼
   auth-service  donation-svc  geocoding   agent-location (Go)
     (Mongo)       (Mongo)     (Redis $)     (Redis GEO)
                      │                           │
                      │ donation.created          │ live location
                      ▼                           ▼
                 ┌─────────────────────────────────────┐
                 │   assignment-engine  (Go)           │
                 │   GEOSEARCH -> score -> top 3       │
                 └──────┬──────────────────────┬───────┘
                        │ donation.assigned    │ donation.unassigned
              ┌─────────┴────────┐             ▼
              ▼                  ▼        donor informed
      notification-service  tracking-service
        (alerts agents)    (status + timeout timers)
                                 │ donation.timeout
                                 └──────► back to assignment-engine
```

Everything between services flows over **Kafka**; no service calls another
directly for events.

**Data ownership** — each store is owned by specific services, never shared:

- **MongoDB** — `auth-service` (users), `donation-service` (donations)
- **Redis** — live agent geolocation, agent capability/load, geocode cache,
  Kafka idempotency keys
- **Kafka** — the event bus
- **Cassandra** *(optional, Phase 11)* — long-term event history for analytics

---

## Repository layout

```
docker-compose.yml     all infrastructure + services, one command
.env.example           every config value, documented
docs/
  PLAN.md              the full specification and non-negotiable decisions
  00-phase0-*.md       Kafka and Redis explained from zero
  01-phase1-*.md       auth-service API, JWT and bcrypt explained
  02-phase2-*.md       donation-service, Kafka producing and the outbox pattern
  03-phase3-*.md       geocoding, Redis caching concepts, the Leaflet map picker
  04-phase4-*.md       Redis Geo, the heartbeat/reaper pattern, first Go service
  05-phase5-*.md       the scoring algorithm, the compatibility matrix, Kafka consuming
  06-phase6-*.md       idempotency, the claim race, timeouts and re-scoring
  07-phase7-*.md       the status state machine, timelines and notifications
  08-phase8-*.md       the agent UI: shift, the offer countdown, and the race
  09-phase9-*.md       the donor dashboard: impact figures and what they count
  10-phase10-*.md      the monitoring view, and why it has no assign button
  11-phase11-*.md      Cassandra data modelling, and the event log as a migration
scripts/
  create-topics.sh     create the 8 Kafka topics (idempotent)
  verify-infra.sh      prove Mongo/Redis/Kafka are actually usable
  smoke-auth.sh        drive the running auth-service over HTTP
  smoke-donation.sh    create donations and read the events back out of Kafka
  smoke-geocoding.sh   geocoding, cache hits, and donation-service's use of it
  smoke-agent-location.sh  agent positions, radius search, raw Redis structures
  smoke-assignment.sh  the full chain: donation -> scoring -> donation.assigned
  smoke-lifecycle.sh   accept races, timeouts and re-offers (waits out a real 90s window)
  smoke-tracking.sh    the whole journey: offered -> accepted -> collected, and who was told
  smoke-frontend.sh    the agent's day, driven through the Vite dev server's proxy
  smoke-donor.sh       the donor dashboard's data: impact, filters, timelines
  smoke-monitoring.sh  score breakdowns, and that no write route exists
  smoke-analytics.sh   Cassandra tables, time-to-assignment, and catch-up after downtime
services/              one directory per microservice
frontend/              React (Vite) donor + agent UI
```

---

## Build progress

| Phase | Scope | Status |
|---|---|---|
| 0 | Infra via docker-compose: Mongo, Redis, Kafka | **done** |
| 1 | `auth-service` — donor/agent signup, login, JWT, bcrypt | **done** |
| 2 | `donation-service` — CRUD, image upload, category field, publishes `donation.created` | **done** |
| 3 | `geocoding-service` — OpenCage + Redis cache, Leaflet map picker | **done** |
| 4 | `agent-location-service` (Go) — live location + capabilities in Redis Geo | **done** |
| 5 | `assignment-engine` (Go) — multi-parameter scoring, auto-assignment | **done** |
| 6 | Offer lifecycle — idempotency, claim race, timeout re-score | **done** |
| 7 | `tracking-service` + `notification-service` | **done** |
| 8 | Agent React UI — shift, live location, offer countdown, accept/collect | **done** |
| 9 | Donor React UI — dashboards, history, stats | |
| 10 | Read-only monitoring view with score breakdowns | **done** |
| 11 | `analytics-service` + Cassandra *(optional)* | **done** |
| 12 | `api-gateway` + full containerization | next |

---

## Tech choices, and why

- **Go** for `assignment-engine` and `agent-location-service` — these are the
  hot paths. Scoring runs on every donation and location updates arrive
  continuously from every active agent; goroutines make the parallel
  score-and-notify fan-out cheap and direct to express.
- **Node/Express** for CRUD and I/O-bound services — auth, donations,
  geocoding, notifications are mostly awaiting a database or an HTTP API.
- **Kafka** so a donation is never lost because a downstream service is down,
  and so new consumers (analytics) can be added without touching producers.
- **Redis** for sub-millisecond geospatial radius queries (`GEOSEARCH`), atomic
  load counters, geocode caching, and event deduplication.
- **MongoDB** — donations carry varying optional fields; a flexible document
  shape fits better than rigid columns.

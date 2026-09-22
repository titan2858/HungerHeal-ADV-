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

## Quick start

```bash
cp .env.example .env          # then fill in JWT_SECRET and OPENCAGE_API_KEY
docker compose up -d          # Mongo, Redis, Kafka, Kafka UI
bash scripts/create-topics.sh # create the 8 event topics
bash scripts/verify-infra.sh  # 6 checks, all should pass

cd frontend && npm install && npm run dev   # http://localhost:5173
```

No OpenCage API key is required — geocoding falls back to a built-in offline
geocoder, and the whole stack works end to end without one.

| Service | URL |
|---|---|
| auth-service | <http://localhost:4001> |
| donation-service | <http://localhost:4002> |
| geocoding-service | <http://localhost:4003> |
| agent-location-service | <http://localhost:4004> |
| assignment-engine (offers API) | <http://localhost:4005> |
| tracking-service | <http://localhost:4006> |
| notification-service | <http://localhost:4007> |
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
| 10 | Read-only monitoring view with score breakdowns *(optional)* | |
| 11 | `analytics-service` + Cassandra *(optional)* | |
| 12 | `api-gateway` + full containerization | |

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

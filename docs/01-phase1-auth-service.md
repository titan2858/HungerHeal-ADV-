# Phase 1 — auth-service

Donor and agent registration, login, and the JWT that every other service will
trust. Node.js + Express + MongoDB, listening on **:4001**.

```bash
docker compose up -d --build auth-service   # run it
bash scripts/smoke-auth.sh                  # 17 HTTP checks against the container
cd services/auth-service && npm test        # 28 unit/integration tests
```

---

## API

### `POST /auth/signup`

The body is a **discriminated union on `role`** — the valid shape depends on
whether a donor or an agent is signing up.

Donor:

```json
{
  "role": "DONOR",
  "name": "Asha Donor",
  "email": "asha@example.com",
  "phone": "+91 9876543210",
  "password": "goodpass1"
}
```

Agent — must additionally declare what it can physically carry:

```json
{
  "role": "AGENT",
  "name": "Ravi Agent",
  "email": "ravi@example.com",
  "phone": "+91 9876500000",
  "password": "goodpass1",
  "capabilities": {
    "vehicleType": "MOTORCYCLE",
    "hasInsulatedTransport": true,
    "hasRefrigeration": false,
    "categoriesHandled": ["COOKED_PREPARED", "BAKERY"]
  }
}
```

`201` returns `{ user, token }` — a token is issued immediately, so a client is
logged in without a second round trip to `/auth/login`.

### `POST /auth/login`

`{ email, password }` → `200 { user, token }`.

### `GET /auth/me`

Requires `Authorization: Bearer <token>` → `200 { user }`.

### `GET /health` and `GET /ready`

`/health` answers "is this process alive" and is what Docker's healthcheck
polls. `/ready` additionally reports whether Mongo is reachable.

They are deliberately separate. If `/health` also checked Mongo, a Mongo outage
would make Docker declare the container unhealthy and restart it — punishing a
service for a dependency's failure, and destroying the logs that would explain
what happened.

### Error shape

Every failure, from every endpoint, returns the same body:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "request body failed validation",
    "details": [{ "field": "capabilities.categoriesHandled", "message": "..." }],
    "traceId": "e6c7cd52-b9e2-4a24-8609-5ccc61e696d1"
  }
}
```

The `traceId` is the useful part: a user can report a failure, and that id finds
every log line for the request across every service.

---

## How the password is stored

Plaintext passwords are never stored, and never logged. Signup runs the password
through **bcrypt** with a cost factor of 10 and stores only the resulting hash.

Bcrypt is used rather than SHA-256 because it is *deliberately slow*. A fast
hash is a liability here: a leaked database of SHA-256 password hashes can be
brute-forced at billions of guesses per second on a GPU. Bcrypt's cost factor
makes each guess take roughly 100 ms, so the same attack becomes impractical.
The cost is also tunable upward as hardware gets faster, without changing any
code.

Two further protections:

- `passwordHash` is declared `select: false` in the schema, so it is omitted
  from every query result unless explicitly requested. It cannot leak into an
  API response by accident.
- The logger redacts `password`, `passwordHash`, `token` and the
  `authorization` header, so a careless log call cannot print a credential.

### Why login is identical for "wrong password" and "unknown email"

Both return exactly `401 invalid email or password`. If the messages differed,
the endpoint would become a tool for discovering which email addresses have
accounts.

There is also a subtler leak: bcrypt comparison takes ~100 ms, so returning
early for an unknown email would be measurably *faster* than a wrong password,
revealing the same information through timing. The controller therefore compares
against a dummy hash when no user is found, so both paths cost the same.

---

## What a JWT is, and why this project uses one

A JWT is three base64 segments — header, payload, signature — joined by dots.
The payload here is small on purpose:

```json
{ "sub": "<userId>", "role": "AGENT", "email": "ravi@example.com" }
```

The signature is computed over the payload with `JWT_SECRET`. Anyone holding
that secret can verify the payload has not been altered — change a single
character of `role` and verification fails.

**Why this shape matters for a microservices build:** `api-gateway` (Phase 12)
verifies the token once at the edge and passes the decoded identity downstream.
No other service has to call auth-service to ask "who is this?" — the token
itself is the proof. That is the difference between a signed token and a session
id, which would require a lookup on every request and make auth-service a
dependency of literally every operation in the system.

The tradeoff to be honest about: **a JWT cannot be revoked before it expires.**
Tokens here last 7 days, so a compromised token stays valid that long. Real
mitigations are short-lived access tokens plus a refresh token, or a revocation
list in Redis. Neither is in this phase's scope, and the 7-day window is the
accepted tradeoff for a demo system.

Because the secret is what makes the whole scheme work, **every service that
verifies tokens must share the same `JWT_SECRET`.** It lives in the root `.env`
and is injected by compose. `.env` is gitignored; `.env.example` is what is
committed.

---

## Agent capabilities, and why they are collected at signup

`capabilities` is not incidental profile data — it is a direct input to the
assignment algorithm in Phase 5:

| Field | Used by scoring for |
|---|---|
| `categoriesHandled` | Which donations this agent is eligible for at all |
| `hasInsulatedTransport` | Cooked food requires it; drives category compatibility |
| `hasRefrigeration` | Raw perishables prefer it |
| `vehicleType` | Feeds compatibility (a bicycle is not a van) |

A new agent is also seeded with:

- `rating: 3.5` — **not 0.** Rating is 15% of the score, and a new agent with no
  completed pickups has no evidence either way. Starting at 0 would lose them
  every comparison and mean they never receive a first assignment to build a
  rating from. A neutral midpoint keeps them competitive.
- `ratingCount: 0` — so a real average can be computed once history exists.

These live in MongoDB as the source of truth, and will be **mirrored into Redis**
by `agent-location-service` in Phase 4. The reason: `assignment-engine` reads
capabilities for every candidate agent on every scoring pass, and a Mongo round
trip per candidate would dominate the matching latency that the whole design
exists to minimize.

The signup schema is `.strict()`, so it rejects unknown fields. A donor sending
`capabilities` is a 400, not a silently ignored field.

---

## Structured logging, from this phase onward

Every log line is JSON and carries a `traceId`:

```json
{"level":30,"time":"2026-09-13T09:29:52.669Z","service":"auth-service",
 "traceId":"e6c7cd52-...","method":"GET","path":"/auth/me","status":200,
 "durationMs":6.84,"msg":"request completed"}
```

An incoming `x-trace-id` header is **reused rather than replaced**. That single
decision is what makes tracing work end to end: api-gateway generates the id,
donation-service stamps it onto the `donation.created` Kafka event,
assignment-engine logs its scoring under the same id. Following one donation
through the entire system then reduces to:

```bash
docker compose logs | grep <traceId>
```

This is the cheap version of distributed tracing, and it is enough for this
project's scope — no Jaeger or Grafana needed.

---

## Structure

```
services/auth-service/
  src/
    index.js                  server bootstrap + graceful shutdown
    app.js                    express app (separate from index.js so tests
                              can drive it in-process without a port)
    config/env.js             zod-validated config; refuses to boot if wrong
    config/db.js              mongoose connection
    domain/categories.js      the 5 food categories, vehicle types, default rating
    models/User.js            donor + agent schema
    routes/auth.schemas.js    request validation (discriminated on role)
    routes/auth.routes.js
    controllers/auth.controller.js
    middleware/               requestContext, validate, requireAuth, errorHandler
    utils/                    logger, jwt, ApiError
  tests/auth.test.js          28 tests
  Dockerfile
```

Two structural choices worth naming:

- **`app.js` is separate from `index.js`.** The app is a function returning an
  Express instance; `index.js` connects to Mongo and listens. Tests import
  `createApp()` and drive it in-process with supertest — no port binding, no
  race conditions, no leftover server between test files.
- **Config is validated at boot** (`config/env.js`) and the process exits if it
  is wrong. A service that starts happily with a missing `JWT_SECRET` and only
  fails on the first login is much harder to diagnose than one that refuses to
  start and says why. This was not theoretical — it caught an invalid
  `LOG_LEVEL` on the first test run.

---

## Testing approach

**28 tests** in `npm test`, plus **17 HTTP checks** in `scripts/smoke-auth.sh`.
The split is intentional:

- `npm test` runs against the app in-process and covers logic: validation rules,
  duplicate detection, that the stored password is a bcrypt hash and not the
  plaintext, that a tampered token is rejected, that a repeated category is
  deduplicated.
- `smoke-auth.sh` drives the **running container** over HTTP, which is the only
  way to catch a broken Dockerfile, a wrong `MONGO_URI` for the compose network,
  or a missing environment variable — none of which the unit suite can see.

Tests run against the real dockerized MongoDB in a separate `hh_auth_test`
database, rather than an in-memory substitute. That keeps the unique index and
schema validation under test as they actually behave in production.

---

## Deliberately not in this phase

- **Rate limiting on login.** Brute-force protection belongs at api-gateway
  (Phase 12) so it covers every service, not just this one.
- **Refresh tokens / revocation.** See the JWT tradeoff above.
- **Password reset and email verification.** Real product needs, no bearing on
  the automated-assignment problem this project exists to solve.
- **Kafka.** auth-service publishes no events. Nothing in the assignment flow
  reacts to a signup, and adding a `user.created` topic that no service consumes
  would be architecture for its own sake.

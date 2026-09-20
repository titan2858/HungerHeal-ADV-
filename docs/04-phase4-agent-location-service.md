# Phase 4 — agent-location-service (Go)

Agents push their live position and capabilities into Redis. This is the data
`assignment-engine` will read on every single donation in Phase 5, so its shape
is a contract, not an implementation detail.

Go 1.26 + go-redis, listening on **:4004**.

```bash
docker compose up -d --build agent-location-service
bash scripts/smoke-agent-location.sh              # 33 checks against the running stack
cd services/agent-location-service && go test ./... # 14 tests against real Redis
```

---

## Why Go for this one

Two reasons, both concrete rather than a preference for the language:

**This is the highest-frequency write in the system.** Every active agent
reports a position every 15-30 seconds, all of them at once, forever. The
handler does two Redis writes in one pipeline and nothing else. Go's goroutine
model handles that fan-in without a thread per connection or an event-loop
bottleneck.

**Phase 5 is the real reason.** `assignment-engine` will score candidates and
notify the top three *in parallel*, and Go's concurrency primitives make that
fan-out direct to express. Building this smaller service first means the Redis
access patterns, the JWT middleware, the logging format, and the Docker build
are all proven before the hardest part of the project is written on top of them.

The image is also **30 MB, against 286 MB for the Node services** — a multi-stage
build ships the compiled binary, not the toolchain.

---

## API

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /agents/location` | agents | Report position (the hot path) |
| `POST /agents/availability` | agents | Accept work or not, while staying online |
| `POST /agents/offline` | agents | End shift — removed from matching at once |
| `GET /agents/me` | agents | Everything currently stored about the caller |
| `GET /agents/nearby` | any | Radius search — the Phase 5 query |
| `POST /agents/{id}/load` | any | Adjust pending-pickup counter (temporary) |
| `GET /health`, `GET /ready` | open | Liveness and Redis check |

The agent id always comes from the **token**, never the request body, so one
agent cannot move another agent's pin.

---

## The four Redis structures

Three structures hold an agent, each chosen for what it does well:

| Key | Type | Holds |
|---|---|---|
| `agents:live` | **GEO set** | Every agent's position — answers "who is within 5km?" |
| `agent:<id>:caps` | **HASH** | Capabilities, rating, name, phone, availability |
| `agent:<id>:load` | **counter** | Pending pickups, `INCR`/`DECR` atomically |
| `agent:<id>:alive` | **string + TTL** | Presence heartbeat |

That fourth one exists to work around a real constraint, and it is the most
interesting thing in this phase.

### A geo set cannot expire its members

A Redis geo set is a **sorted set** underneath. Whole *keys* can have a TTL, but
individual *members* of a sorted set cannot. There is no way to say "forget this
agent's location in two minutes."

Left alone, an agent who closes the app stays in the geo set forever at their
last known position. `assignment-engine` then cheerfully offers them donations
they will never see, the offer times out, and the donation has to be
reassigned — burning exactly the minutes that matter most for hot food.

The fix is two-part:

1. **A separate `:alive` key that does expire**, refreshed on every location
   report and checked on every read. This is what keeps matching *correct*.
2. **A background reaper goroutine** that periodically `ZREM`s geo entries whose
   heartbeat is gone. This is not about correctness — reads already skip stale
   agents. It stops the geo set accumulating every agent who ever used the app,
   which would make every search scan more members and hold memory forever.

```go
go runReaper(reaperCtx, st, cfg.ReapInterval, logger)
```

A ticker in a goroutine — no scheduler, no cron container. The kind of thing Go
makes unremarkable.

### GEOADD takes longitude first

```go
pipe.GeoAdd(ctx, GeoKey, &redis.GeoLocation{
    Name: agentID, Longitude: lng, Latitude: lat,
})
```

Reversing these produces **no error** — just an agent who appears to be in the
wrong hemisphere and is never matched to anything nearby. The same trap applies
to GeoJSON in donation-service, and both have tests pinning the order.

### One pipeline, not N round trips

`Nearby` runs `GEOSEARCH`, then fetches each candidate's heartbeat,
capabilities and load **in a single pipeline**:

```go
for i, r := range results {
    cmds[i] = pending{
        alive: pipe.Exists(ctx, AliveKey(r.Name)),
        caps:  pipe.HGetAll(ctx, CapsKey(r.Name)),
        load:  pipe.Get(ctx, LoadKey(r.Name)),
    }
}
```

With 50 candidates that is 3 round trips instead of 150. Everything the scoring
formula needs arrives in one query — otherwise `assignment-engine` would make a
round trip per candidate, on the one path where latency directly costs food
quality.

`redis.Nil` is expected here and deliberately not treated as an error: an agent
with no accepted pickups has no load key at all.

### The load counter clamps at zero

```go
if n < 0 { /* reset to 0 */ }
```

Kafka delivers at least once, so a replayed `donation.collected` event can
decrement twice. Going negative would make the agent look **more** available the
more events were replayed — exactly backwards. There is a test for this.

---

## How capabilities get into Redis

Capabilities are declared at signup and live in auth-service's MongoDB. The
matching hot path needs them in Redis.

On an agent's **first location report**, this service calls auth-service's
existing `GET /auth/me`, **forwarding the agent's own token**:

```go
req.Header.Set("Authorization", bearerToken)
```

Two things that matters for:

- No new endpoint was needed on auth-service.
- This service never holds a privileged machine credential that could read
  anyone's record. It can only ever fetch the profile of whoever is calling.

If auth-service is slow or down, the report is **not rejected** — it falls back
to the name and phone already in the token plus a neutral 3.5 rating, and logs a
warning. An agent's position is time-sensitive; dropping it because another
service was briefly slow would take a working agent out of matching entirely.

The capability hash has **no TTL**, deliberately. Capabilities are not presence:
an agent offline for a week has not stopped owning an insulated box, and
re-fetching on every reconnect would be wasted work. The smoke test asserts
`TTL == -1` on that key.

---

## Category is a hard filter, not a score penalty

```go
if opts.Category != "" && !agent.Capabilities.Handles(opts.Category) {
    continue
}
```

An agent who does not carry cooked food should never be offered it, however
close they are. This happens *before* scoring — it is not a low score, it is
exclusion. Compare with `hasInsulatedTransport`, which *is* a scoring input
because it is a matter of degree.

Availability works the same way, with one exception: a monitoring view can pass
`includeUnavailable=true`, because seeing why nobody was matched is exactly what
such a view is for.

---

## Structured logging across two languages

The Go service uses `log/slog` with a JSON handler, emitting the same shape the
Node services emit via pino, and it **reuses an incoming `x-trace-id`** rather
than generating its own.

So this still works, across services written in different languages:

```bash
docker compose logs | grep <traceId>
```

---

## Security details worth naming

**The JWT algorithm is pinned:**

```go
if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
    return nil, jwt.ErrSignatureInvalid
}
```

Without this check an attacker can present a token signed with `"none"`, or an
RS256 token verified against the public key as if it were an HMAC secret, and
have it accepted. It is one of the best-known JWT vulnerabilities and one line
to prevent.

**Panics are recovered.** Go's default behaviour on an unrecovered panic in a
handler goroutine is to crash the whole process — one malformed request would
take down every agent's location reporting at once.

**Timeouts everywhere.** `ReadTimeout`, `WriteTimeout`, `IdleTimeout` on the
server, and a timeout on the auth-service client. Without them a single stalled
client or an unresponsive dependency holds resources open indefinitely.

**Coordinates are validated for NaN and Inf**, not just range. Redis would store
them without complaint and they would poison every distance calculation that
touched them.

**`lat`/`lng` are `*float64`, not `float64`**, so a missing field can be told
apart from a legitimate zero. Longitude 0 is the Greenwich meridian and latitude
0 is the equator — both real places.

---

## Testing

**14 Go tests** against the **real dockerized Redis**, not a mock. The whole
point of the package is GEOADD/GEOSEARCH semantics and per-member expiry; a mock
would only assert that we call the functions we wrote, not that Redis behaves
the way the design assumes.

They use real Bengaluru landmarks so distances are genuine, and cover: the
380m/5km/850km radius cases, nearest-first ordering, the staleness filter,
reaping, category filtering, availability, the load counter clamping at zero,
and that a moving agent updates their position rather than appearing twice.

The test cleanup deletes only `agent:test-*` keys and the geo set — never
`FLUSHALL`, which would destroy the geocoding cache sharing the same instance.

**33 smoke checks** additionally assert on the **raw Redis structures**
(`ZSCORE`, `GEOPOS`, `HGET`, `TTL`) rather than only HTTP responses, because
that data shape is the contract Phase 5 reads directly.

---

## What Phase 5 will do with this

`assignment-engine` will **not** call this service's HTTP endpoints on the hot
path — it will run the same `GEOSEARCH` against Redis directly, because going
through another service's HTTP layer would add latency for nothing.

`GET /agents/nearby` exists so that query can be inspected and debugged by hand:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4004/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5&category=COOKED_PREPARED"
```

Every field the scoring formula needs is already in that response — distance,
category compatibility, current load, rating.

---

## Deliberately not in this phase

- **Kafka.** This service publishes no events yet. A location update is not a
  fact any other service needs to react to; Redis is the live source of truth,
  and Phase 11's analytics can read `agent.location.updated` if it is ever
  worth emitting.
- **Location history.** Only the current position is kept. A breadcrumb trail
  is an analytics feature, and storing every ping forever in Redis would be the
  wrong place for it.
- **Driving load from events.** `POST /agents/{id}/load` is a temporary handle
  so the counter can be exercised. In Phase 7 tracking-service drives it from
  `donation.accepted` / `.collected` / `.rejected`, because load changes are
  consequences of those events, not something a client should assert.

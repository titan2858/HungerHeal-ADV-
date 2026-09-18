# Phase 2 — donation-service

Donors create donations with photos; every creation publishes a
`donation.created` event to Kafka. Node.js + Express + MongoDB + Multer +
KafkaJS, listening on **:4002**.

This is the phase where Kafka stops being infrastructure and starts carrying
real events.

```bash
docker compose up -d --build donation-service
bash scripts/smoke-donation.sh          # 28 checks, incl. reading the event back out of Kafka
cd services/donation-service && npm test # 39 tests
```

---

## API

All endpoints require `Authorization: Bearer <token>` — a token issued by
auth-service in Phase 1.

### `POST /donations` (donors only)

Accepts **either** JSON **or** `multipart/form-data` (needed for photos). The
same schema handles both, because `z.coerce` turns multipart's string-typed
fields back into numbers and dates.

```json
{
  "title": "Leftover biryani from a wedding",
  "description": "About 40 servings, cooked this evening",
  "category": "COOKED_PREPARED",
  "quantityAmount": 40,
  "quantityUnit": "SERVINGS",
  "pickupAddress": "12 MG Road, Bengaluru 560001",
  "lat": 12.9716,
  "lng": 77.5946,
  "bestBefore": "2026-09-19T20:00:00Z"
}
```

Up to 5 images via the `images` field, 5 MB each, JPEG/PNG/WebP/GIF only.

The `201` response includes `assignmentQueued: true|false` — whether the event
actually reached Kafka. See "the dual-write problem" below for why that flag is
honest rather than decorative.

`lat`/`lng` are optional in this phase; Phase 3's geocoding-service will derive
them from the address. A donation without coordinates cannot be matched, so the
response says so explicitly rather than failing silently.

### `GET /donations`

Filters: `status`, `category`, `limit`, `offset`.

**Donors see only their own donations. Agents see all of them** — browsing
what's available is their job. This is enforced in the query filter, not by
discarding rows afterwards, so a donor's query can never even reach another
donor's data.

### `GET /donations/:id`

A donation belonging to another donor returns **404, not 403**. A 403 would
confirm the id is real, which is enough to enumerate donation ids.

### `GET /uploads/:filename`

Donation photos, served from disk.

---

## The donation.created event

```json
{
  "eventId": "0a5d9a92-0ea7-4354-9815-1810f5360b7f",
  "eventType": "donation.created",
  "eventVersion": 1,
  "occurredAt": "2026-09-18T15:22:33.878Z",
  "traceId": "phase2-smoke-1789744953",
  "donationId": "6aad57397ab16e26ecde2200",
  "donorId": "6aad5738...",
  "category": "COOKED_PREPARED",
  "quantity": { "amount": 40, "unit": "SERVINGS" },
  "bestBefore": "2026-09-19T15:22:33.000Z",
  "pickup": { "address": "12 MG Road, Bengaluru 560001", "lng": 77.5946, "lat": 12.9716 }
}
```

Three fields do real work:

**`eventId`** — Kafka delivers *at least* once. A consumer that crashes after
doing its work but before committing its offset sees this exact message again on
restart, which would double-assign a donation. In Phase 6 consumers will `SETNX`
this id in Redis and skip anything already handled. Without a stable per-event
id there is nothing to deduplicate on.

**`traceId`** — carried from the HTTP request, through Mongo, onto the event. One
grep follows a donation across every service.

**The pickup coordinates and category, carried *in* the event.** This is a
deliberate design choice. assignment-engine could have received just a
`donationId` and called back to fetch the rest — but then the two services would
be coupled again, and a donation-service outage would stall all matching. A
self-contained event means the engine can score using only what it was handed.

### Why the message key matters

Every event is published with `key = donationId`. Kafka routes by key hash, so
all events for one donation land on the **same partition** — and ordering is
only guaranteed within a partition.

Without this, `donation.accepted` could be processed before
`donation.assigned` for the same donation, because they'd sit on different
partitions consumed at different speeds. With it, per-donation order is
guaranteed while different donations still spread across all 3 partitions for
throughput.

---

## The dual-write problem, and the outbox

Creating a donation means writing to **two** systems: save to Mongo, then
publish to Kafka. No transaction spans both.

If the process dies between them, the donation exists but assignment-engine
never hears about it. The donor sees a successful submission and their food is
never collected — silent, and the worst possible failure for this product.

The standard fix is the **transactional outbox**: record the event durably with
the entity, then relay it to the broker separately. This is a light version —
the donation row carries its own `eventPublished` flag instead of a separate
outbox collection, which fits because there is exactly one event per donation.

The ordering is the whole point:

1. save the donation with `eventPublished: false` — **durable first**
2. try to publish
3. on success, set `eventPublished: true`

A crash anywhere leaves a donation the sweeper will find and retry every 15
seconds. The cost is that an event may be published *twice* (crash between 2 and
3) — which is exactly why consumers deduplicate on `eventId`. At-least-once
delivery plus idempotent consumers is the standard trade, and both halves have
to be built for either to work.

### This was verified, not assumed

Kafka was stopped, a donation created, then Kafka restarted:

```
--- creating a donation with the broker DOWN ---
HTTP status: 201
assignmentQueued: false
eventPublished=false attempts=1 status=PENDING_ASSIGNMENT

--- kafka restarted, 35s later ---
eventPublished=true attempts=2
```

and the sweeper's log line:

```json
{"traceId":"76682237-146a-4be7-ad17-54107d48ca08","retry":true,
 "donationId":"6aad577e...","eventId":"9c268654-...","msg":"published donation.created"}
{"component":"outbox","pending":1,"published":1,"msg":"outbox sweep completed"}
```

Note the `traceId` on the retry is the **original** one from the request four
minutes earlier — the recovery is traceable to the donation that caused it.

**The donor got a 201 the whole time.** A broker outage is never the donor's
problem, and they are never asked to re-submit food that is already recorded.
This is also why `/ready` reports Kafka as down but still returns 200: refusing
traffic would throw away the exact donations the design exists to protect.

---

## Kafka producer settings

```js
producer = kafka.producer({ idempotent: true });
```

An idempotent producer tags each message with a sequence number, so a retry
after a network blip cannot append the same message twice. Without it, "did my
write land?" is unanswerable — retrying risks a duplicate, not retrying risks
losing the donation.

Setting it also forces `acks=all`: the broker only acknowledges once the message
is durably written, rather than as soon as it is received into memory.

---

## Image upload

Multer writes to disk with a **randomised filename**, never the client's:

```js
cb(null, `${Date.now()}-${randomUUID()}${ext}`);
```

A client-supplied name is three problems at once — `../../etc/passwd` is path
traversal, `x.png.js` is a double-extension trick, and two donors uploading
`photo.jpg` collide. A random id with a whitelisted extension removes all three.

The mime check uses the client-declared type, so it is a usability guard, not a
security boundary — a real check would sniff magic bytes. It's sufficient here
because uploads are only ever served as static files, never executed.

Serving from local disk is the pragmatic choice for this project. The honest
production answer is object storage behind a CDN, because a local volume does
not survive the container being replaced and does not work at all once this
service runs as more than one replica.

---

## Three bugs the tests caught

These are worth recording because each was a real defect, not a test problem.

**1. Ungeocoded donations returned 500.** Declared as a plain nested object,
Mongoose helpfully writes `location: { type: 'Point' }` with no `coordinates`
for every donation without a lat/lng — and the 2dsphere index rejects that with
`Can't extract geo keys`. Fix: a proper subdocument schema with
`default: undefined`, so the field stays genuinely absent until there is
something to store. The `default: undefined` is load-bearing, not style.

**2. A skipped publish was reported as a success.** With `KAFKA_ENABLED=false`,
`publish()` returns `{ skipped: true }` without throwing, so donations were
being marked `eventPublished: true` when nothing was ever sent — and the outbox
would never retry them. Fix: treat a skip as a failure to publish.

**3. Failed uploads left orphaned files.** Multer writes to disk before
validation runs, and a validation failure short-circuits straight to the error
handler without passing through the controller — so the controller's cleanup
never ran. Fix: clean up in `errorHandler`, the one funnel every failure goes
through.

---

## A Phase 1 change this phase forced

An agent arriving for a pickup needs someone to call, so every donation
snapshots the donor's name and phone. Those weren't in the JWT — it carried only
`sub`, `role`, `email`.

Two options: call auth-service at creation time, or put them in the token. The
token won, because it keeps donation creation working even when auth-service is
down, which is the whole reason for verifying a signed token locally instead of
looking up a session.

The tradeoff, stated honestly: a user who changes their phone number keeps
issuing the old one until their token expires (7 days). Acceptable for contact
details that are snapshotted per donation anyway — it would **not** be
acceptable for anything security-relevant like `role`.

auth-service now has two **contract tests** asserting the token carries `name`
and `phone`. If those claims are ever removed, the failure would otherwise show
up in a different service's directory with no obvious link back — so the
contract is asserted at the source.

---

## Why status transitions are not here

The model defines the full lifecycle (`PENDING_ASSIGNMENT`, `OFFERED`,
`ACCEPTED`, `COLLECTED`, `UNASSIGNED`, `CANCELLED`, `EXPIRED`), but
donation-service only ever sets `PENDING_ASSIGNMENT`, at creation.

There is deliberately **no update-status endpoint.** Every other transition is
owned by tracking-service in Phase 7, driven by events. One service owning the
lifecycle is what stops two services disagreeing about a donation's state — the
kind of bug that is close to impossible to debug once it happens in production.

---

## Testing

**39 tests** (`npm test`) and **28 smoke checks** (`scripts/smoke-donation.sh`).

The unit suite runs with `KAFKA_ENABLED=false`, so it needs no broker and stays
fast. That means "the event really reached a topic" is only ever proven by the
smoke test, which **consumes `donation.created` back out of Kafka** and asserts
the event contents and the message key:

```
4. THE EVENT IS ACTUALLY IN KAFKA
  [PASS] donation.created event found on the topic
  [PASS] traceId propagated HTTP -> Mongo -> Kafka event
  [PASS] event carries an eventId (what consumers dedupe on)
5. [PASS] message key is the donationId
```

Watch events arrive live at <http://localhost:8090> (Kafka UI → topics →
`donation.created`), or:

```bash
docker exec -it hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic donation.created --from-beginning
```

---

## Deliberately not in this phase

- **Editing or deleting a donation.** Not needed by the assignment flow.
- **Cancelling a donation.** It is a status transition, and those belong to
  tracking-service.
- **Geocoding.** Phase 3. Coordinates are accepted now and derived then.
- **Consuming any events.** donation-service only produces. It will consume
  status events in Phase 7, once there are any.

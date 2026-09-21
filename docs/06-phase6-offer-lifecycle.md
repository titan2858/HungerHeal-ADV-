# Phase 6 — the offer lifecycle: idempotency, the claim race, and timeouts

Phase 5 could match a donation to three agents. It could not cope with any of
what happens next: an agent accepting, two agents accepting at once, nobody
answering, or Kafka delivering the same event twice.

This phase closes all four, and with it the automation is genuinely complete. A
donation now either reaches an agent or the donor is told why — with no human
anywhere, and no way for it to get stuck.

```bash
docker compose up -d --build assignment-engine
cd services/assignment-engine && go test ./...   # 85 tests, no infrastructure needed
bash scripts/smoke-lifecycle.sh                  # the real lifecycle, ~4 minutes
```

---

## The four gaps, and what closed them

### 1. Idempotency — a redelivered event assigning the donation twice

Kafka guarantees *at-least-once* delivery. The consume loop is fetch → work →
commit, so a crash **after** publishing `donation.assigned` but **before**
committing the offset means Kafka hands the same `donation.created` back on
restart.

Without a guard the engine scores again and publishes a second
`donation.assigned`: six agents notified for one meal, two of them driving to
the same door, and the load counters double-counted.

Every event has carried a unique `eventId` since Phase 2 for exactly this.
Before any work runs:

```go
fresh, err := store.BeginProcessing(ctx, eventID)   // SETNX processed:<eventId>
if !fresh { skip and commit }
```

`SETNX` is atomic, so it also holds when two engine instances receive the same
redelivery simultaneously — exactly one gets `true`. There is a test firing 20
goroutines at one event id and asserting precisely one is granted.

**The ordering trap.** The marker is set *before* the work. If the work then
fails — Redis blipped, Kafka refused the publish — and the marker stayed, the
redelivery would be *skipped*, losing the donation precisely when the system was
already having a bad day. So a failure calls `AbandonProcessing`, which deletes
the marker so the retry actually retries.

**A weakness the smoke test exposed.** Dedup originally read `eventId` from the
Kafka **header**. Replaying an event through a console producer drops headers,
the id came back empty, and the donation was assigned a second time. Headers are
the convenient place to look but are not guaranteed to survive every path into a
topic — a replay, a mirroring tool, a hand-crafted message. The body always
carries `eventId`, so **the body is now authoritative** and the header is only a
fallback. That was a real bug found by a test doing something slightly unusual.

### 2. The claim race — two agents both accepting

The plan requires notifying the top 3 **in parallel**; offering serially would
mean 4.5 minutes of 90-second waits for a meal going cold. Parallel offers create
a race: three phones buzz at once and two agents can tap Accept in the same
second.

The same primitive, used as a lock:

```go
SETNX donation:<id>:claimed <agentId>
```

Redis executes one command at a time, so there is no window in which two callers
both create the key. The winner gets `200`; everyone else gets `409 ALREADY_CLAIMED`
— **not an error page**, because losing a race you were invited into is a normal
outcome and the app should close the notification cleanly.

Accepting also:

- **clears the deadline**, so the watcher does not re-offer a donation someone is
  already driving to collect;
- **increments the agent's load counter** — which has to happen before the next
  donation is scored, or an agent who just accepted still looks idle and
  immediately wins another.

### 3. Nothing counted down the timeout

The 90-second window was computed and stamped onto the event in Phase 5, and
then no code ever read it. If all three agents ignored the notification the
donation sat there forever while the donor watched a spinner.

A `Watcher` goroutine now polls a sorted set of deadlines:

```
ZADD offers:deadlines <expiresAt> <donationId>
ZRANGEBYSCORE offers:deadlines -inf <now>
```

**Why a sorted set rather than Redis key expiry?** Redis *can* notify on key
expiry, and it is the obvious answer — but keyspace notifications are
fire-and-forget, delivered only to subscribers connected at that exact moment.
Restart the service during a deploy and every deadline in that window is
silently lost, with the donations stuck and nothing in the logs to say why.

A sorted set is **durable state instead of a notification**. The watcher asks
"what is overdue right now?" on every tick, so a restart loses nothing — it
finds the overdue offers on its next pass.

`TakeDeadline` uses `ZREM`'s return value to claim an expiry: every engine
instance sees the same overdue donation, but `ZREM` returns 1 for only one of
them, so one expiry produces exactly one `donation.timeout` event however many
instances are running.

### 4. The re-score loop and the exclusion set

Once timeouts fire, re-scoring naively is worse than useless: nothing about the
top 3 has changed, so the re-score finds the identical three agents and offers it
straight back to the people who just ignored it. The donation bounces between
them until it expires.

So `HandleTimeout` adds the whole lapsed batch to `donation:<id>:declined` first,
and passes that set as `excluded` to `RankAgents` — the parameter that was wired
and unit-tested in Phase 5 but had nothing to populate it.

Two further details:

**The re-score resumes from the radius it left off at**, not from 5 km. Every
agent inside the previous circle is already excluded, so re-searching it would
just find nobody.

**`MaxRounds` (default 4) stops the loop.** A city with a hundred agents would
otherwise work through all of them one batch at a time while the food goes cold.
At some point "nobody is taking this" is the honest answer, and the donor is
better served by being told than by an indefinite spinner. That publishes
`donation.unassigned` with `ALL_AGENTS_EXHAUSTED`.

---

## Rejection: better than a timeout

An agent can decline explicitly, and it is genuinely useful information rather
than a failure. A decline adds them to the exclusion set and, **when the whole
batch has answered, re-scores immediately** instead of waiting out the rest of a
window nobody is going to meet. That is up to 90 seconds of a hot meal's life
recovered for free.

The early re-score is done by **publishing a `donation.timeout` event**, not by
calling the re-score function inline. That looks like a detour and is
deliberate: the re-offer then travels the same durable, deduplicated path as a
real timeout, rather than a second code path that could quietly drift out of
step with it.

---

## The API

Three endpoints, agents only, with the agent id always taken from the **token**
— never the body, so one agent cannot answer on another's behalf.

| Endpoint | Meaning |
|---|---|
| `POST /offers/{donationId}/accept` | `200` you won · `409` someone was faster · `410` expired |
| `POST /offers/{donationId}/reject` | Records the decline, returns how many are still deciding |
| `GET /offers/{donationId}` | Is this offer still open? (so the app can grey out the button) |

Responding to a donation you were never offered returns **404, not 403**. A 403
would confirm the id is real, letting an agent probe for other people's
donations.

### Why accept lives in assignment-engine, not tracking-service

Accepting is not a status update — it is **winning a race** between three agents
notified at the same moment, and only the service holding the claim lock can
arbitrate it atomically. The engine made the offers, so the engine settles them.

tracking-service (Phase 7) consumes the resulting `donation.accepted` event to
drive donation status and notify the donor. Clean split: **the engine owns offer
arbitration; tracking-service owns the donation's status lifecycle.**

---

## The complete flow, as it now runs

```
donation.created
     │
     ▼
 assignment-engine  ── GEOSEARCH → score → top 3 ──▶ donation.assigned  (round 1)
     │                                                    │
     │                        ┌───────────────────────────┴──────────┐
     │                        ▼                                      ▼
     │                 agent accepts                        nobody answers (90s)
     │                        │                                      │
     │                 SETNX claim lock                    watcher publishes
     │                 exactly one wins                     donation.timeout
     │                        │                                      │
     │                        ▼                                      ▼
     │                donation.accepted                    exclude that batch,
     │                 load counter ++                      re-score → round 2
     │                                                               │
     │                                        ┌──────────────────────┴───────┐
     │                                        ▼                              ▼
     │                                 someone accepts            MaxRounds reached
     │                                                                       │
     ▼                                                                       ▼
 no coordinates / nobody nearby  ─────────────────────▶  donation.unassigned
```

Every transition is an event on Kafka, every consumer is deduplicated on
`eventId`, and every event carries the donor's original `traceId` — so a
re-offer four minutes later still appears under the same trace as the HTTP
request that created the donation.

---

## Redis, all four uses now live

| Key | Type | Purpose |
|---|---|---|
| `processed:<eventId>` | string + TTL | Idempotency — has this event been handled? |
| `donation:<id>:claimed` | string (SETNX) | The claim lock — who won the race? |
| `donation:<id>:declined` | set | Who must not be re-offered this donation |
| `donation:<id>:offer` | hash | Enough state to re-score without asking donation-service |
| `offers:deadlines` | sorted set | Which offers have run out of time |
| `agent:<id>:load` | counter | Pending pickups, feeding the 0.20 scoring term |

Three of them are the same `SETNX` primitive doing three different jobs, which is
worth noticing: "atomically create this key only if nobody else has" answers
*"have I done this already?"*, *"did somebody beat me to it?"*, and *"am I the
one who should act?"*.

---

## Testing

**85 Go tests**, none of which need infrastructure for the engine logic:

- **35 scoring** — pure, fabricated numbers.
- **35 engine** — fakes for Redis and Kafka. The fake offer store implements the
  semantics that *matter* (SETNX wins once, declines accumulate), so the claim
  race and the re-score loop are tested as behaviour rather than plumbing.
  Includes a concurrency test firing three simultaneous accepts and asserting
  exactly one winner.
- **15 offers** — against **real Redis**, because this package rests entirely on
  the exact semantics of `SETNX`, `ZREM` and sorted-set range queries under
  concurrency. A fake would only prove we call the functions we wrote.

Then `scripts/smoke-lifecycle.sh` drives the real thing and **genuinely waits out
a 90-second window** — that wait *is* the test. It replays a real event to prove
dedup, fires two simultaneous accepts through HTTP to prove the lock, and checks
that round 2 goes to different agents than round 1.

### What the first smoke run taught

Two failures, and they were different in kind:

1. **A real bug**: dedup depended on a Kafka header that the replay did not
   carry. Fixed by reading `eventId` from the body.
2. **Correct behaviour that looked like a bug**: sections 3–5 reported
   `candidatesFound: 0`. The agents' **120-second heartbeats had expired** part
   way through a five-minute script, and the reaper had removed them — exactly
   what Phase 4 built. The script now refreshes agent positions the way a real
   agent app does, every 15–30 seconds.

The second one is worth keeping in mind when testing this system by hand: **an
agent who stops reporting stops existing**, within two minutes.

A third, smaller thing showed up in the engine's own log output during the run:
`"round":1,"round":2` on one line. `HandleTimeout` bound `round` to the logger
and `offerRound` then added it again, producing a duplicate JSON key - which log
processors are free to drop or reorder, so the line could end up saying
something other than what happened. The bound field is now `timedOutRound`.

---

## Known gaps, still honest

- **No dead-letter topic.** A message that cannot be parsed is committed and
  logged loudly, because leaving it uncommitted would block the partition
  forever. Holding it somewhere for inspection is the proper answer.
- **A publish failure inside the watcher loses that deadline.** It has already
  been taken from the sorted set, so if publishing `donation.timeout` then fails,
  nothing re-arms it and that donation stalls. It is logged as an error. The fix
  is to re-add the deadline on a publish failure — small, and worth doing.
- **Nobody consumes `donation.accepted` / `.rejected` / `.unassigned` yet.** The
  events are published and correct; tracking-service and notification-service
  are Phase 7. Until then the donor is not actually *told* anything — the system
  knows, but nothing delivers the message.
- **`responseSeconds` is derived** from the offer's expiry minus the configured
  window, rather than from a stored "offered at" timestamp. Accurate enough for
  analytics, slightly indirect.

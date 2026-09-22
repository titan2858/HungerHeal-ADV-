# Phase 7 — tracking-service and notification-service

Phase 6 made the system decide correctly. Nothing **told anybody**. The engine
knew a donation had been offered, accepted, timed out or abandoned, and that
knowledge went nowhere.

This phase adds the two consumers that close that gap: one owns the donation's
status and history, the other turns events into messages people actually read.

Node.js + Express + MongoDB + KafkaJS on **:4006** and **:4007**.

```bash
docker compose up -d --build tracking-service notification-service
bash scripts/smoke-tracking.sh                       # 35 checks, the full journey
cd services/tracking-service && npm test             # 17 tests, no infrastructure
cd services/notification-service && npm test         # 19 tests, no infrastructure
```

---

## The thing worth noticing first

**Neither service required a single change to any existing service.** No
producer was touched, no event was modified, no configuration was added
anywhere else. They were written, given their own consumer groups, and started.

That is the payoff Phase 0 promised when it explained consumer groups: two
*different* groups reading one topic each receive **every** message. There are
now three groups on the same topics — `assignment-engine`, `tracking-service`,
`notification-service` — and each gets the full stream independently.

There was a second, better demonstration on first boot. Both services subscribe
with `fromBeginning: true`, so on startup they **replayed the entire history**
of every topic and reconstructed status and notifications for donations created
days earlier, before either service existed:

```
tracking-service      donationId 6ab01272...  PENDING_ASSIGNMENT -> UNASSIGNED
notification-service  donationId 6ab28261...  created 3 notifications
```

Nobody wrote a migration. The log *was* the migration.

---

## tracking-service — one owner of the status

### Why this service exists at all

Every service has an opinion about a donation's state. donation-service knows it
was created; assignment-engine knows who was offered it; the agent knows they
collected it. If each wrote its own idea of "status", they would disagree — and
a system where two services disagree about a donation's state is close to
impossible to debug.

So exactly one service decides, and that is this one. donation-service sets
`PENDING_ASSIGNMENT` once at creation and never touches it again.

### The state machine is pure

`src/domain/statusMachine.js` imports nothing. No Mongo, no Kafka, no clock —
the same discipline as the scoring package in Phase 5, for the same reason: "are
the lifecycle rules right?" should be answerable by a unit test with no
infrastructure. All 17 of its tests run with Docker stopped.

### Why legality checks matter more than they look

Events for one donation are keyed by `donationId`, so events **on the same
topic** arrive in order. But `donation.assigned` and `donation.accepted` are
*different topics* — different partitions, consumed at independent speeds.
There is **no ordering guarantee between them**.

So `accepted` can genuinely be processed before `assigned`. The state machine
makes that harmless rather than catastrophic:

```js
PENDING_ASSIGNMENT -> ACCEPTED   // legal: covers exactly this case
COLLECTED -> anything            // refused: terminal states never move
```

The terminal guard is the important one. Without it a redelivered
`donation.assigned` arriving after collection would move finished food back to
`OFFERED` and re-notify agents about a pickup that already happened. The smoke
test publishes exactly that late event and asserts the status stays `COLLECTED`.

### One ordering decision worth explaining

`applyEvent` checks *"is it already in this status?"* **before** *"is this
transition legal?"*. The outcome is identical either way — nothing changes — but
the **reason code** differs, and the reason code drives whether a warning is
logged.

A duplicate `donation.accepted` is a routine Kafka redelivery, not an anomaly.
Reporting it as `ILLEGAL_TRANSITION` would log a warning for every ordinary
redelivery and train anyone reading the logs to ignore the warnings that matter.
A unit test caught this ordering.

### The timeline is the point, not a side effect

A status field answers *"where is it now?"*. The timeline answers *"what
happened, when, and to whom?"* — which is what a donor actually asks when their
food has not been collected.

Crucially, **every event is recorded, including ones that changed nothing**:

```
Donation received: COOKED_PREPARED at MG Road, Bengaluru
Offered to 3 nearby agent(s): trkalpha, trkbravo, trkcharlie
An agent declined: already busy. 2 still deciding
Round 1 went unanswered by 3 agent(s); finding others
trkalpha accepted and is on the way
```

"Three agents were asked and all declined" is exactly the history that explains
a slow collection, and a status-changes-only log would throw it away.

### Marking collected returns 202, not 200

```js
POST /tracking/:donationId/collected  ->  202 { status: "COLLECTING" }
```

The service **publishes `donation.collected` and then consumes its own event**
through the normal path, rather than writing the status directly.

That looks like a detour and is deliberate. The event is what decrements the
agent's load counter and reaches notification-service; applying the change
locally and skipping the event would leave the rest of the system unaware. Going
through the log keeps **one** place where a status is written.

`202 Accepted` is the honest status code for that: the request was accepted, the
work completes momentarily.

---

## notification-service — turning events into messages

### The templates are pure too

`src/domain/templates.js` maps an event to the notifications it should produce.
One event can produce several (an offer goes to three agents at once) or none at
all, and *which* is a rule worth testing on its own.

### What it deliberately does NOT send

**A donor is told nothing when an agent declines.** The other two are still
deciding; a notification per decline would be alarming noise that teaches people
to ignore the app.

**A donor is told nothing on a timeout.** The engine is already re-offering.

**A donor is told nothing when agents are offered the donation.** They get the
tracking view for that. There is a smoke assertion that the donor's inbox
contains zero `OFFER` notifications.

Deciding what *not* to send is most of notification design. Every unnecessary
message reduces the attention paid to the necessary ones.

### The message changes with the reason

`donation.unassigned` carries a machine-readable reason, and each one calls for
a different response from the donor:

| Reason | Message | Kind |
|---|---|---|
| `NOT_GEOCODED` | "Set the location on the map so an agent can be sent" | **ACTION_NEEDED** |
| `NO_AGENTS_FOUND` | "Nobody is nearby right now. We will keep trying." | update |
| `NO_ELIGIBLE_AGENTS` | "Agents are nearby but none can carry this type of food" | update |
| `ALL_AGENTS_EXHAUSTED` | "Every nearby agent has been asked and none could take it" | **ACTION_NEEDED** |

The first is something the donor can fix. The second is something they can only
wait for. Collapsing them into "something went wrong" would waste the
distinction the engine went to the trouble of making.

### Closing the losing offers

When one agent wins, the other two hold a notification counting down an offer
that is already gone. Tapping Accept returns `409`, and they reasonably conclude
the app is broken.

So `donation.accepted` also creates an `OFFER_CLOSED` notification for each
loser and marks their stale offers read — leaving a badge lit for something
nobody can act on is its own small failure.

### A unique index as the last line of defence

```js
{ sourceEventId: 1, recipientId: 1 }  // unique
```

Redis dedup already prevents duplicates. This index makes them **physically
impossible** rather than merely unlikely — an agent seeing the same collection
request twice would be tapping an offer that is already theirs. `insertMany` uses
`ordered: false`, so one duplicate in a batch of three does not stop the other
two from being delivered.

### Offers expire from the inbox

A 90-second collection request shown an hour later is worse than useless:
tapping it fails. The list endpoint filters on `expiresAt` so the app does not
have to know the rule.

---

## Dedup keys are namespaced per service

```
processed:tracking:<eventId>
processed:notify:<eventId>
processed:<eventId>          (assignment-engine)
```

Three services process the *same* events and each must get its own turn. A
shared key would mean whichever consumed first silently suppressed the others —
a bug that would look like "notifications randomly stop working".

---

## Data ownership, kept honest

| Database | Owner |
|---|---|
| `hh_auth` | auth-service |
| `hh_donations` | donation-service |
| `hh_tracking` | tracking-service |
| `hh_notifications` | notification-service |

Nobody reads anybody else's. tracking-service does **not** update
donation-service's `status` field; it keeps its own projection built from the
event stream. There is exactly one deliberate exception in the whole system, and
it is documented in Phase 5: assignment-engine reads the Redis keys
agent-location-service writes, because that is the matching hot path.

---

## Testing

**36 unit tests**, none of which need infrastructure:

- **17 tracking** — the state machine: terminal guards, out-of-order delivery,
  timeline-only events, illegal transitions, and that every status has a
  sentence a donor can read rather than an enum.
- **19 notification** — which notifications each event produces, including the
  cases that must produce **none**, and that a missing phone number does not
  render `undefined` into a message a human reads.

**35 smoke checks** drive the whole journey end to end: donation → offered →
three agents notified in parallel → accepted → losers told → collected → donor
thanked, plus authorization, the terminal-state guard against a replayed event,
and the unread-count lifecycle.

### One failure worth recording

The first smoke run failed section 5 with `notifications got 000` — a
connection refused. I had rebuilt notification-service moments before running,
and the container was still starting. Everything after it passed, because by
then it was up.

Not a code bug, but the lesson is real: **a smoke test that starts before its
dependencies are healthy reports failures that are not there**, which is just as
misleading as passing when it should not. Waiting for the healthcheck first is
part of running the test, not a nicety.

---

## Known gaps

- **Notifications are in-app only.** No push, no SMS, no email. The
  infrastructure for real delivery (a provider, device tokens, retry on failed
  delivery) is a genuine piece of work, and a `GET /notifications` inbox is the
  honest scope here. `priority: HIGH` is already carried on the ones that would
  justify waking a phone.
- **No websocket or polling push.** The agent app would have to poll
  `/notifications/unread-count`. Given a 90-second offer window, polling every
  few seconds is adequate but crude; server-sent events would be the next step.
- **donation-service's own `status` field is now stale.** It sets
  `PENDING_ASSIGNMENT` and never hears about the rest, so its list endpoint
  shows the creation-time status. tracking-service is the authority. Making
  donation-service consume status events to refresh its copy is a small job and
  worth doing before the donor UI in Phase 9 reads from it.
- **No cancel-by-donor endpoint.** `CANCELLED` exists in the state machine and
  is tested, but nothing publishes it yet.

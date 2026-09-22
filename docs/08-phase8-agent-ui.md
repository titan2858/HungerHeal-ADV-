# Phase 8 — the agent UI

Everything the backend does has been real since Phase 7. An agent could not
actually *use* any of it: there was no way to go on shift, no way to see a
collection request, no way to accept one.

React + Leaflet on **:5173**, sharing the app the donor already uses.

```bash
cd frontend && npm run dev          # http://localhost:5173
bash scripts/smoke-frontend.sh      # 33 checks through the dev server's proxy
```

---

## What the agent sees

| Section | What it does |
|---|---|
| **Shift** | Go on shift → location shared every 20s. End shift → removed from matching at once. |
| **Availability** | Stay on the map but stop receiving new requests. |
| **Collection requests** | Open offers with a live countdown, Accept / Decline. |
| **To collect** | Accepted donations, with Mark collected. |
| **Recent** | The notification inbox. |

---

## The three decisions worth explaining

### 1. Why the location reports every 20 seconds

The backend trusts a reported position for `AGENT_TTL_SECONDS` (120s), after
which the reaper removes the agent from the geo set entirely.

Reporting every 110s would technically satisfy that window — and would drop the
agent out of matching the first time a single request failed. Reporting every
**20s gives six chances** to survive a lapse: a tunnel, a lift, a few seconds of
no signal.

This is not housekeeping. **An agent who stops reporting stops existing**, and
the UI's whole job here is to make sure that does not happen by accident.

Which is why the panel shows `Last reported 14:32:05 · reporting every 20s`.
"Why am I not getting any offers?" is the question an agent will ask, and the
answer is usually visible right there: if that timestamp stops advancing, the
server has stopped hearing from this device. The alternative — a silent failure
with a green dot — is how you get an agent who thinks the app is broken when
their location permission lapsed.

### 2. Ending a shift is explicit, not implicit

```js
await api.goOffline();   // ZREM from the geo set, immediately
```

Waiting for the heartbeat to lapse would leave a finished agent receiving offers
for **up to two minutes** — and every one of those offers times out, which
delays the donation by a full 90-second window each time. The cost of an implicit
sign-off is paid by the food, not the agent.

### 3. Polling, and being honest that it is the crude part

`useOffers` polls every 5 seconds while on shift. Offers live 90 seconds, so an
agent sees a request within 5s and has ~85s to decide, at a cost of 12 requests
a minute.

**Server-sent events or a websocket would deliver the offer the instant it
exists.** For a 90-second window, 5s of latency is acceptable; for a 20-second
window it would not be. This is a deliberate trade, not an oversight — and
polling stops entirely when the agent is off shift, because they cannot be
offered anything anyway.

---

## The race, as a user experience

Three agents see the same card at the same moment. One wins. Most of the work in
`OfferCard` is making that feel like a normal part of the job:

| Response | What the agent sees |
|---|---|
| `200` | "Yours — head to the pickup address." |
| `409` | **"Another agent accepted this one first."** |
| `410` | "This request expired." |

A 409 is **not an error state**. Losing a race you were invited into is the
expected outcome two times out of three, and rendering it as "something went
wrong" would make a correctly-working system feel broken.

There is a smoke check asserting the second accept really does return 409, because
the card branches on that exact status. If it ever became a 500, the agent would
see a failure message instead of an explanation.

Two supporting details:

- **The card disappears the moment it is answered**, without waiting for the
  next poll. A countdown still ticking on a donation you just accepted makes the
  app feel broken even though the answer landed.
- **An expired card stays visible** for a moment rather than vanishing mid-tap,
  which would leave the agent unsure what happened.

The countdown turns amber under 30 seconds — the last third of the window —
because an agent glancing at a phone should not have to read a number to know it
is nearly gone. It uses `font-variant-numeric: tabular-nums` so the card does not
twitch on every tick.

### Showing the rank

The offer says *"Ranked #2 for this pickup"*. That is the scoring from Phase 5
surfacing in the product: it explains **why** they were asked and sets
expectations. Being ranked #3 of 3 means two better-suited agents were asked at
the same moment, and the odds of winning this one are lower.

---

## The donor view now reads tracking-service

This is a correction to something Phase 7 left broken.

donation-service sets `PENDING_ASSIGNMENT` once at creation and never hears
about the rest, so its `status` field goes stale the instant an agent is
offered the donation. The donor list was reading it.

It now reads `tracking-service`, which is the single owner of the status. The
smoke test asserts both halves of this:

```
[PASS] donor sees: "Collected. Thank you."
[PASS] donation-service still says PENDING_ASSIGNMENT - the known stale field the UI avoids
```

Leaving that assertion in is deliberate. The gap is still there in
donation-service, and the test documents it rather than letting it be quietly
forgotten.

The donor also gets an expandable **History** — the timeline from Phase 7,
which is what actually answers "why has nobody collected my food yet?":

```
14:32:01  Donation received: COOKED_PREPARED at MG Road, Bengaluru
14:32:04  Offered to 3 nearby agent(s): Ravi, Priya, Sunil
14:33:34  Round 1 went unanswered by 3 agent(s); finding others
14:33:36  Re-offered to 2 agent(s) after round 1 went unanswered
14:33:51  Ravi accepted and is on the way
```

---

## Testing the frontend's wiring

The services were proven in Phases 1–7. What was untested is the **frontend's
wiring**: proxy routes, path rewrites, and the request shapes the client sends.
A proxy typo produces a 404 that no backend test can catch.

So `scripts/smoke-frontend.sh` makes **every request through the Vite dev
server on :5173**, using the exact paths the React app calls, and walks the
agent's whole day: sign up → go on shift → receive an offer → accept → see it in
the collect list → mark collected → end shift.

### Two things the first run caught

**A stray `)` in the script**, which killed it at section 6.

**Two proxy assertions that were wrong, not broken.** `/api/auth` rewrites to
`/auth`, so `/api/auth/health` correctly 404s — the app never calls that path.
The test now proves the proxy reaches the service by a different signal: an
anonymous request returning **401 from the service** rather than **404 from
Vite**. Same for `/api/donations`, `/api/tracking` and `/api/notify`.

That distinction is the whole point of the check. A 404 means Vite never
forwarded the request anywhere; a 401 means it arrived and was rejected on its
merits.

---

## Deliberately not in this phase

- **A map on the agent side.** An agent needs an address and a phone number,
  and their phone's own map app does turn-by-turn far better than an embedded
  Leaflet view would. Worth adding a "directions" link, not a map.
- **Offline support / service worker.** A real collection app would need it;
  it is a substantial piece of work and not on the path to demonstrating the
  matching engine.
- **Push notifications.** The backend gap noted in Phase 7 — the inbox carries
  `priority: HIGH` on the offers that would justify waking a phone, but nothing
  delivers them outside the app.
- **Donor polish.** Dashboards, stats and styling are Phase 9. The donor view
  here got exactly the correction it needed to stop showing a stale status, and
  nothing more.

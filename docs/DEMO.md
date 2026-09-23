# HungerHeal — demo walkthrough

A 10-minute run-through that shows the system doing the one thing it exists to
do: **place a donation with an agent, automatically, and explain why.**

---

## Before you start

```bash
docker compose up -d --build       # ~30s once images are built
curl http://localhost:4000/ready   # must say "ready" for all 7 services
```

Optionally add Cassandra and analytics:

```bash
docker compose --profile analytics up -d
```

Open two browser windows at **<http://localhost:8080>**:

- a **normal window** — this will be the donor
- an **incognito window** — this will be the agent

You need two, because the login token lives in `localStorage` and one browser
profile holds one session.

> **The one thing that will make it look broken:** a donation is only matched if
> an agent is **on shift within range of it**. With nobody on shift, a donation
> correctly ends up "No agent available yet" — the system working exactly as
> designed. Do the agent setup *first*.

---

## The 10-minute run

### 1. Set the scene (1 min)

> "This is a food donation platform. The version before it had an **admin who
> manually assigned every donation to a collection agent** — a human deciding
> who collects what, based on proximity and availability. That doesn't scale,
> and it's especially bad for perishable food, because the bottleneck is a
> person who has to be awake and looking at a screen.
>
> This rebuild removes that person entirely. Same product, event-driven
> microservices, and the manual step replaced by a multi-parameter matching
> engine."

### 2. Put an agent on the map (1 min)

**Incognito window** → Sign up → **"I collect food"**

- Tick **insulated bag or box**
- Select **cooked prepared** as a category
- Create account → **Go on shift** → allow location access

> "The agent declares what they can physically carry at registration —
> insulated transport, refrigeration, which food categories. That isn't profile
> decoration; it's a direct input to the scoring in a moment.
>
> Going on shift starts sharing location every 20 seconds. The backend trusts a
> position for 120 seconds, so 20 gives six chances to survive a tunnel. An
> agent who stops reporting stops existing — and that panel shows the last
> report time, because 'why am I not getting offers?' is usually answered
> right there."

### 3. Post a donation (2 min)

**Normal window** → Sign up → **"I donate food"**

Fill in the form:

- Title: *Leftover biryani from a wedding*
- Category: **Cooked / prepared meals** — note the hint: *needs insulated
  transport · high urgency*
- Quantity: 40 servings
- **Use my location** in the map picker ← important, so the pickup is near the
  agent

> "The category isn't cosmetic. It decides which agents are eligible at all, and
> it sets how long they get to respond — 90 seconds for hot food, five minutes
> for tinned goods."

Post it, then switch to the agent window.

### 4. The offer arrives (1 min)

Within about five seconds the agent sees a **collection request with a live
countdown**.

> "Nothing happened by hand. The donation was created, an event went onto Kafka,
> the matching engine picked it up, ran a geospatial query in Redis for agents
> within 5km, scored them, and offered it to the top three **in parallel** —
> all in about a second.
>
> The card says 'Ranked #1 for this pickup'. That's the scoring surfacing in the
> product, so the agent knows why they were asked."

**Accept it.**

### 5. Both sides update (1 min)

**Donor window** → *"An agent is on the way"* with the agent's phone number.

**Agent window** → the donation appears under **To collect**.

> "Three agents were asked at once, so two of them could have tapped Accept in
> the same second. A Redis SETNX lock settles that — exactly one wins, the
> others get a 409 which the app renders as 'another agent accepted this one
> first'. Losing a race you were invited into is a normal outcome, not an
> error."

**Mark collected** in the agent window → donor sees *"Collected. Thank you."*
and the impact figures update.

### 6. Show the reasoning (2 min) ← **the most important part**

Open a third window (or log out) → Sign up → **"Monitor"** → find the donation
and click it.

> "This is the read-only monitoring view. It shows **every candidate that was
> scored**, not just the winner, with all four weighted terms."

Point at the breakdown:

```
#1 Ravi                                      0.9022 / 0.95
   Distance      ████████████████████░  0.99  × 0.35   0.3472
   Category fit  █████████████████████  1.00  × 0.25   0.2500
   Current load  █████████████████████  1.00  × 0.20   0.2000
   Rating        ██████████████░░░░░░░  0.70  × 0.15   0.1050
```

> "Distance is 35% of the decision — the biggest factor, but **not the only
> one**. If there were a closer agent without an insulated box, they'd score
> 0.40 on category fit instead of 1.00, and lose. I can demonstrate that.
>
> There is **no assign button here, deliberately**. The whole point was removing
> the human from assignment — an override button puts them straight back, and
> the first time a donation looked slow somebody would press it. The right
> response to a bad assignment is to read this breakdown, see which term caused
> it, and change the scoring."

### 7. Show the machinery (2 min)

**Kafka UI** — <http://localhost:8090> → Topics → `donation.assigned`

> "Every service communicates through these topics. donation-service doesn't
> know assignment-engine exists — it appends a fact and moves on."

**Trace one donation across all nine services:**

```bash
docker compose logs | grep <traceId>
```

(The traceId is on the monitoring detail view.)

> "One id follows a donation from the browser, through the gateway, into Mongo,
> onto Kafka, through the Go matching engine, into the status service. That's
> the cheap version of distributed tracing and it's enough for this scale."

---

## Optional: the three things worth showing if there's time

### A. Equipment beating proximity

Sign up a second agent **without** an insulated box, slightly closer than the
first. Post cooked food. The **farther, better-equipped** agent wins.

```
equipped(0.809) beat barenear(0.735)   -- 1.1km farther, and still won
```

> "That's the thesis of the whole project in one line: distance is 35% of the
> decision, not all of it."

### B. The timeout loop

Post a donation and **don't answer it**. After 90 seconds it's automatically
re-offered to *different* agents — the ones who ignored it are excluded.

```bash
docker compose logs assignment-engine | grep -E "window closed|re-scoring"
```

> "Nobody is watching a queue. A watcher polls a sorted set of deadlines in
> Redis, publishes a timeout event, and the engine re-scores excluding whoever
> just ignored it."

### C. Nothing is lost when a service dies

```bash
docker compose stop assignment-engine
# post a donation — it still succeeds
docker compose start assignment-engine
# it gets matched within seconds
```

> "The donation waited in Kafka. That's the difference between an event log and
> a direct HTTP call: with a call, donation-service fails when the engine is
> down and the donor is told to try again."

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| "No agent available yet" | Nobody on shift, or the agent is far from the pickup. Use **"Use my location"**. |
| Offer never arrives | Agent's shift ended, or location permission was denied. Check the last-reported time. |
| Everything 502s | A service is still starting. `curl localhost:4000/ready`. |
| Docker won't connect | Docker Desktop isn't running — it doesn't auto-start. |

---

## Or skip the clicking entirely

Every part of this runs headless against the live stack:

```bash
bash scripts/smoke-gateway.sh      # the whole journey through one port
bash scripts/smoke-monitoring.sh   # score breakdowns, and no write route
bash scripts/smoke-lifecycle.sh    # accept races and a real 90s timeout (~4 min)
```

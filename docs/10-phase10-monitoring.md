# Phase 10 — the read-only monitoring view

The original system had an admin who could say *"I gave it to Ravi because he's
closest."* The replacement has to be able to answer the same question, and
**"the algorithm decided" is not an answer** when a donation went to the wrong
person.

This view makes the scoring inspectable. It has no assign button, and that
absence is the design.

```bash
bash scripts/smoke-monitoring.sh   # 30 checks, including that no write route exists
```

Sign up with the **Monitor** role at <http://localhost:5173>.

---

## Read-only is the whole point

`docs/PLAN.md`, section 1:

> **No manual admin-assignment panel.** If any admin/monitoring view exists, it
> is strictly **read-only** — shows what the algorithm decided and *why* (score
> breakdown), with no assign/reassign controls.

So `monitoring.routes.js` contains three routes and all three are `GET`. There
is no POST, PATCH or DELETE anywhere in the file.

That is not squeamishness. The entire point of the rebuild was removing the
human bottleneck from assignment. An override button would put them straight
back — and the first time a donation looked slow, somebody would press it.
Within a month "just reassign it manually" becomes the workaround for every
scoring problem, and nobody ever fixes the scoring.

**The smoke test asserts the absence**, which is the only way a non-existent
feature stays non-existent:

```
[PASS] POST on a donation is not a route (404)
[PASS] PUT on a donation is not a route (404)
[PASS] PATCH on a donation is not a route (404)
[PASS] DELETE on a donation is not a route (404)
[PASS] there is no assign endpoint at all (404)
```

If any of those ever returns something else, a human has been handed back the
ability to override the algorithm, and the test fails loudly.

The right response to a bad assignment is to look at the breakdown, understand
which term produced it, and change the scoring — not to fix one donation by
hand.

---

## What the breakdown shows

For every candidate that was scored, not just the winner:

```
#1 p10near                                    0.9022 / 0.95
   Distance      ████████████████████░  0.99  × 0.35   0.3472
   Category fit  █████████████████████  1.00  × 0.25   0.2500
   Current load  █████████████████████  1.00  × 0.20   0.2000
   Rating        ██████████████░░░░░░░  0.70  × 0.15   0.1050
   0.14 km away · 0 pending pickups · rated 3.5

#2 p10bare                                    0.7522 / 0.95
   Distance      ████████████████████░  0.99  × 0.35   0.3472
   Category fit  ████████░░░░░░░░░░░░░  0.40  × 0.25   0.1000
   ...
```

Two agents at effectively the same distance, and the view shows exactly where
they diverged: **1.00 versus 0.40 on category fit**, because one has an
insulated box and the food was cooked. That difference — 0.15 of the final
score — is what chose the winner, and anyone looking at this can see it.

Three details that make it trustworthy rather than decorative:

**The bars show the RAW 0–1 term, not the weighted one.** How well an agent did
on a factor is worth seeing independently of how much that factor counts.

**The numbers add up, and there is a test for it.** The four weighted terms sum
exactly to the total score. An explanation that does not reconcile is a fiction,
and a plausible-looking fiction is worse than no explanation at all.

**The scale is stated: `/ 0.95`.** The plan's weights sum to 0.95, not 1.0, so a
perfect agent scores 0.95. Showing "0.9022" with no denominator invites the
question and answers nothing.

### It is stored, not recomputed

`tracking-service` captures the breakdowns from `donation.assigned` and keeps
them. Recomputing later would read agent state that has since changed — their
load, their position, even their rating. **The only honest record of why an
agent was chosen is the one captured at the moment of the decision**, which is
exactly why assignment-engine has been putting the breakdown on the event since
Phase 5.

---

## The statistics that matter

```
8s        average offer → accept
76.5%     matched on the first offer
1.31      average rounds
```

**First-round match rate is the single best measure of whether the scoring
works.** If the top three agents usually say yes, the ranking is picking well.
If most donations need a second or third round, the scoring is choosing agents
who do not want the work — and that is a weights problem, visible here before
anyone complains.

Failure reasons are broken out separately:

```
Unmatched: 12 × no agents found · 3 × all agents exhausted
```

Those need different responses. *"Nobody was online"* means recruit agents or
widen the radius ladder. *"Everyone declined"* means the scoring is offering to
people who do not want it. Collapsing both into "unmatched" would hide which
problem you actually have.

---

## The ADMIN role

`auth-service` gained a third role. It grants **exactly one thing**: the ability
to open this view.

The smoke test pins that boundary from both sides:

```
[PASS] an admin cannot create donations (403)
[PASS] an admin cannot report an agent location (403)
[PASS] a donor cannot open the monitoring view (403)
[PASS] an agent cannot either (403)
```

It is a viewing permission, not an operator role.

**Self-registration for ADMIN is a local-development convenience**, so the view
can be opened without seeding a user by hand. A real deployment would provision
these accounts rather than letting anyone claim one. That is noted in the
schema itself rather than left as an accident waiting to be discovered.

### One test this broke

`auth-service` had a test called *"rejects an unknown role"* that used `ADMIN`
as its example of an unknown role. Adding the role made it fail — correctly. It
now uses `WAREHOUSE`, and two new tests cover ADMIN signup and that an admin
sending agent capabilities is rejected.

---

## The operator's next step is built in

Every detail view shows the donation's `traceId`. That is the thread that
follows it through all seven services:

```bash
docker compose logs | grep 671f4508-0073-4f99-a9df-35224fa4cf6c
```

A monitoring view that shows you a problem and then leaves you to find it is
half a tool. This one hands over the id that makes the next step a single
command.

---

## Deliberately not in this phase

- **Any control at all.** Covered above; it is the point.
- **Live-updating charts.** The view refreshes every 8s. With a handful of
  donations a chart would be decoration; the numbers are the content.
- **Agent-level analytics** — who accepts most, who declines most. Genuinely
  useful for operations, and squarely Phase 11's territory rather than a
  per-donation inspection view.
- **Historical trends.** This reads the current state in MongoDB. Anything over
  time is what the Cassandra event history in Phase 11 is for.

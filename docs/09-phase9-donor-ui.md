# Phase 9 — the donor dashboard

Phase 8 gave the donor view its correctness fix: it reads `tracking-service`
rather than donation-service's stale status field. This phase is about what a
donor actually wants to see — what happened to their food, and whether any of
it fed anyone.

```bash
cd frontend && npm run dev     # http://localhost:5173
bash scripts/smoke-donor.sh    # 21 checks on the data the dashboard renders
```

---

## The dashboard, in the order it appears

**Needs attention** comes first, above everything else. A donation that could
not be matched is the only thing on this page a donor can act on, so it does
not sit below a row of figures.

**Your impact** — what was collected, then counts by status, then how the
matching is performing.

**Offer food** — collapsed by default. The form was the whole page in Phase 3
because there was nothing else to show; now it is one action among several.

**Your donations** — filterable, newest activity first, each with an
expandable history.

**Updates** — the donor's notification inbox.

---

## Three decisions about the figures

### 1. Impact counts what was COLLECTED, not what was posted

```js
{ $match: { ...match, status: STATUS.COLLECTED } }
```

Food still sitting in a kitchen has not fed anyone. A dashboard that counted it
would be flattering rather than true, and a donor who saw "340 servings donated"
while three of those donations were still waiting would be being misled by their
own app.

There is a smoke check asserting an offered-but-uncollected donation counts
**zero** delivered.

### 2. Units are never summed together

40 servings plus 12 kg is not 52 of anything. The aggregation groups by unit and
the dashboard shows each figure separately:

```
40 servings collected     12 kg collected
```

Adding them would produce a bigger, more impressive, meaningless number.

### 3. The matching is measured, from the donor's side

```
Agents accepted in 8s on average · 1.4 offer rounds typically needed
```

This is the assignment engine's performance made visible to the person who
benefits from it: how long from a donation being offered to an agent saying yes,
with no human in between. It is computed from `firstOfferedAt` and `acceptedAt`,
which tracking-service has been recording since Phase 7.

`avgOfferRounds` is only shown when it is above 1.05 — "1.0 rounds" tells a
donor nothing, but "2.3 rounds" says the first batch of agents usually declines.

---

## A backend change this phase needed

tracking-service knew a donation's *status* but not what it **was**. Every card
would have needed a second call into donation-service to render a title and a
quantity.

The event already carried most of it, so the fix was small:

- `donation.created` now carries `title`. A one-line producer change —
  consumers plainly need to know what the donation is, not just where it is.
- tracking-service stores `title`, `pickupAddress`, `quantity` and `bestBefore`
  from that event.

These are set **outside the state machine**, because they are facts about the
donation rather than about its status.

### The honest caveat

**Donations created before this change have no title or quantity.** Their
records were written by the old handler, and the consumer group's offsets are
long committed, so those events will not be re-read.

This is a real event-sourcing consideration rather than a bug: the log still
holds every event, so a backfill is *possible* — reset the consumer group to
the earliest offset and let it replay, which the idempotency from Phase 6 makes
safe. It has not been done because the existing records are test data. On a real
system it would be a deliberate, scheduled operation.

The UI handles it either way: `title || category` falls back to the category
name, and the quantity line is omitted when there is nothing to show.

---

## Presentation choices worth naming

**A coloured left edge per status** (amber offered, green accepted, red
unassigned) so a long list is scannable without reading every pill.

**Collected rows are faded** to 0.78 opacity. They are history, not something
needing attention, and the eye should skip past them to the active ones.

**Rows fade in** over 0.25s. The page refreshes itself every 10 seconds, and a
row appearing abruptly under the reader's eye is jarring in a way a short fade
is not.

**`font-variant-numeric: tabular-nums`** on the impact figures, so the numbers
do not shift width as they change.

**The agent's phone is a `tel:` link.** On a phone, "the agent is at the wrong
gate" is solved by tapping the number, not by copying it out.

**Filter chips show counts and disable when empty** rather than disappearing, so
the set of options does not shift around under the cursor.

**"Best before 20:15" appears only within two hours** and only while
uncollected. A donation with six hours left does not need a warning; one with
forty minutes does.

---

## What is tested, and why it is the data rather than the pixels

The donor UI is mostly presentation, and presentation is not what breaks. What
breaks is the data behind it — a field that never arrives, a total that counts
the wrong rows.

So `scripts/smoke-donor.sh` drives the dashboard's **data** through the Vite
proxy: that a tracking row carries enough to render a card without a second
call, that impact counts only collected food, that units stay separate, that the
list trims timelines while the detail view keeps them whole, and that the
donor's inbox contains no offer-level noise.

```
[PASS] an offered-but-uncollected donation counts zero delivered
[PASS] servings and kg are reported separately: ['KG', 'SERVINGS']
       -> 40 servings, 12 kg
[PASS] average time from offer to acceptance: 8s
[PASS] the list trims the timeline to 3 entries per row
[PASS] the detail view has the full history (4 entries)
```

---

## Deliberately not in this phase

- **Charts.** With a handful of donations per donor, a bar chart of four bars is
  decoration. The figures are the content. Worth revisiting if Phase 11's
  analytics gives a system-wide view with enough data to have a shape.
- **Cancelling a donation.** `CANCELLED` exists in the state machine and is
  tested, but nothing publishes it — the same gap noted in Phase 7. It needs an
  endpoint before it needs a button.
- **Editing a donation.** Same reasoning; there is no update path in
  donation-service.
- **Backfilling old tracking records.** Described above as a deliberate
  non-action rather than an oversight.

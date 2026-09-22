# Phase 11 — analytics-service and Cassandra

Long-term event history, and the number the plan asked for: **average time to
assignment**.

Optional, and genuinely so — the whole system runs without it.

```bash
docker compose --profile analytics up -d    # Cassandra + analytics-service
bash scripts/smoke-analytics.sh             # 28 checks
```

---

## The thing that made the case for the whole architecture

On first boot this service consumed the topics `fromBeginning` and wrote
**133 events spanning four days** into Cassandra — including 21 September and
18 September, *days before this service existed*.

```
 day        | created | assigned | accepted | collected
------------+---------+----------+----------+-----------
 2026-09-18 |       3 |     null |     null |      null
 2026-09-20 |      10 |     null |     null |      null
 2026-09-21 |      17 |       17 |        2 |      null
 2026-09-22 |      11 |       17 |        7 |         6
```

Nobody wrote a migration. No producer was changed. No other service was
restarted or even aware of it. A new consumer group was created and Kafka
replayed everything that had ever happened.

This is the concrete payoff of the decision made in Phase 0 — events on a
durable log rather than direct service-to-service calls — and it is the single
most persuasive thing in the project.

---

## Why Cassandra rather than more MongoDB

MongoDB already holds the **current state** — a donation's status, an agent's
profile — and answers *"what is true now?"* well.

This is a different question: *"what happened, in order, over months?"*, with
writes that only ever append and never update.

That shape suits Cassandra. Writes go to a commit log and a memtable with no
read-before-write and no locking, so an append is cheap and stays cheap as the
table grows past what one machine could hold.

### The cost, stated plainly

**You must know your queries before you design your tables.** No ad-hoc joins,
no arbitrary `WHERE`, no "we'll add an index later". Each table exists to answer
one question, and the same event is written into several of them.

In a relational database that duplication would be a normalisation error. Here
it *is* the design — and being able to explain why is the point of having used
it.

| Table | Answers | Partitioned by |
|---|---|---|
| `donation_events` | "the full history of this donation" | `donation_id` |
| `events_by_day` | "what happened today?" | `day` |
| `assignment_outcomes` | "how fast is matching?" | `day` |
| `agent_totals` | "how does this agent behave?" | `agent_id` (counters) |
| `daily_totals` | "how much happened each day?" | `day` (counters) |

`donation_events` and `events_by_day` hold **the same events twice**, because
the first cannot answer the second's question without scanning every partition
— the one thing Cassandra is worst at.

### Four modelling details worth knowing

**The clustering key carries `event_id` as a tie-break.** Two events can share
a millisecond, and in Cassandra an `INSERT` on an existing primary key *is* an
update — so without it, the second would silently overwrite the first.

**Counter tables are a separate type.** Counter columns can only be
incremented, never set, and cannot sit alongside normal columns. The payoff is
that concurrent increments from several consumers cannot lose an update — no
read-modify-write.

**Aggregates are maintained on write, not computed on read.** Cassandra has no
`GROUP BY` worth using across partitions, so `daily_totals` is incremented as
events arrive.

**The writes are not a `BATCH`.** Cassandra's `BATCH` provides atomicity within
*one* partition; these writes span several partitions and tables, and a
multi-partition batch makes the coordinator do more work for no guarantee. It
is a well-known anti-pattern. Independent writes are correct here, and a partial
failure is acceptable for analytics in a way it would never be for a donation.

**The raw event is kept whole** in a `payload` column alongside the extracted
ones. The columns answer today's questions; the payload is what makes
tomorrow's answerable without a migration — which is most of the reason to keep
history at all.

---

## The numbers

```json
{
  "matched": 10,
  "secondsToAccept": { "average": 15.6, "median": 12.1, "p95": 39.1 },
  "offerRounds": { "average": 1.2, "firstRoundRate": 80 }
}
```

**p95 is the number that matters operationally.** The average hides the
donations that took far too long, and those are exactly the ones that spoil. A
15-second average with a 39-second p95 is a healthy system; the same average
with a 200-second p95 is not.

**Acceptance rate per agent** — *given that we offered this agent a donation,
how often did they take it?* — is the number that would feed a learned scoring
model in v2. It is the training label the Phase 5 weights were hand-picked in
the absence of.

Percentiles are computed **in the application**, not in CQL. Cassandra
deliberately has no rich aggregate support across partitions, and pretending
otherwise is how people end up with slow, surprising queries. Pulling a bounded
window and computing locally is the honest shape at this scale; a real pipeline
would roll these up with Spark and store the result.

---

## Optional means optional

The smoke test proves it rather than asserting it:

```
10. THE SERVICE IS OPTIONAL - donations work without it
  [PASS] a donation was created with analytics stopped

11. And it catches up from Kafka when it returns
  [PASS] 2 events for the missed donation were consumed on restart
         -> the events waited in Kafka; nothing was lost
```

analytics-service is stopped, a donation is posted and matched normally, the
service is restarted, and the events it missed are consumed from Kafka. Nothing
was lost and nothing else noticed.

It also sits behind a compose profile, so it does not consume ~1.5 GB of RAM
during ordinary development:

```bash
docker compose up -d                        # 11 containers, no Cassandra
docker compose --profile analytics up -d    # 13, with it
```

---

## Access

ADMIN only, and read-only — the same rule as the monitoring view, asserted the
same way. This service stores history; it has no opinion about what should
happen next.

| Endpoint | Returns |
|---|---|
| `GET /analytics/matching?days=7` | Time-to-assignment: average, median, p95 |
| `GET /analytics/daily?days=7` | Per-day counts, zero-filled |
| `GET /analytics/recent?limit=50` | Today's live event feed |
| `GET /analytics/agents/:id` | One agent's totals and acceptance rate |
| `GET /analytics/donations/:id` | One donation's full history |

---

## Deliberately not in this phase

- **A frontend for it.** The monitoring view in Phase 10 already shows
  per-donation reasoning from MongoDB, which is the view an operator opens
  first. Charts over Cassandra would need enough data to have a shape.
- **Retention / TTL.** Cassandra supports per-row TTL and this history will
  grow forever. A real deployment would set one, or archive to object storage.
  Not doing it is a decision, not an oversight.
- **Spark or a proper OLAP pipeline.** The right answer above a few thousand
  rows a day, and considerably more machinery than this project needs.
- **Re-deriving the scoring weights from `acceptanceRate`.** The data to do it
  is now being collected, which was the point — but fitting a model is a
  project of its own, and the Phase 5 note about logistic regression stands as
  the honest next step rather than something quietly half-done.

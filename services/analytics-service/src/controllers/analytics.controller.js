import { getClient } from '../config/cassandra.js';

const dayOf = (d) => d.toISOString().slice(0, 10);

// Every query here reads ONE partition, or a small set of them by key.
// Cassandra rewards knowing the question in advance and punishes anything that
// scans across partitions, so each endpoint maps onto a table built for it.

// GET /analytics/donations/:donationId - the full history of one donation.
export async function donationHistory(req, res, next) {
  try {
    // A single-partition read, already in chronological order on disk. This is
    // the operation Cassandra is fastest at, and the reason donation_events is
    // partitioned by donation_id.
    const result = await getClient().execute(
      `SELECT occurred_at, event_id, event_type, agent_id, agent_name, status, round,
              score, reason, trace_id
       FROM donation_events WHERE donation_id = ?`,
      [req.params.donationId],
      { prepare: true },
    );

    res.json({
      donationId: req.params.donationId,
      events: result.rows.map((r) => ({
        occurredAt: r.occurred_at,
        eventType: r.event_type,
        agentId: r.agent_id,
        agentName: r.agent_name,
        round: r.round,
        score: r.score,
        reason: r.reason,
        traceId: r.trace_id,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /analytics/daily?days=7 - rollups, pre-aggregated on write.
export async function daily(req, res, next) {
  try {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const keys = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      return dayOf(d);
    });

    // Counters maintained as events arrive, rather than computed now.
    // Cassandra has no GROUP BY worth using across partitions, so the
    // aggregate has to be built on write.
    const result = await getClient().execute(
      'SELECT day, created, assigned, accepted, collected, unassigned, timed_out FROM daily_totals WHERE day IN ?',
      [keys],
      { prepare: true },
    );

    const byDay = Object.fromEntries(
      result.rows.map((r) => [
        r.day,
        {
          created: Number(r.created ?? 0),
          assigned: Number(r.assigned ?? 0),
          accepted: Number(r.accepted ?? 0),
          collected: Number(r.collected ?? 0),
          unassigned: Number(r.unassigned ?? 0),
          timedOut: Number(r.timed_out ?? 0),
        },
      ]),
    );

    res.json({
      days: keys.map((day) => ({
        day,
        ...(byDay[day] ?? {
          created: 0, assigned: 0, accepted: 0, collected: 0, unassigned: 0, timedOut: 0,
        }),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /analytics/matching?days=7 - the headline the plan asked for:
// average time to assignment.
export async function matching(req, res, next) {
  try {
    const days = Math.min(Number(req.query.days) || 7, 30);
    const keys = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      return dayOf(d);
    });

    const result = await getClient().execute(
      `SELECT day, seconds_to_accept, offer_rounds, category, urgency, score
       FROM assignment_outcomes WHERE day IN ?`,
      [keys],
      { prepare: true },
    );

    const rows = result.rows.filter((r) => r.seconds_to_accept != null);

    if (rows.length === 0) {
      return res.json({ matched: 0, note: 'no completed assignments in this window' });
    }

    const seconds = rows.map((r) => Number(r.seconds_to_accept)).sort((a, b) => a - b);
    const rounds = rows.map((r) => Number(r.offer_rounds ?? 1));

    // Aggregated in the application, not in CQL.
    //
    // Cassandra deliberately has no percentile or rich aggregate support -
    // pretending otherwise across partitions is how people end up with slow,
    // surprising queries. Pulling a bounded window and computing here is the
    // honest shape at this scale; a real pipeline would roll these up with
    // Spark and store the result.
    const byCategory = {};
    for (const r of rows) {
      const key = r.category ?? 'unknown';
      byCategory[key] ??= { matched: 0, totalSeconds: 0 };
      byCategory[key].matched += 1;
      byCategory[key].totalSeconds += Number(r.seconds_to_accept);
    }

    res.json({
      windowDays: days,
      matched: rows.length,
      secondsToAccept: {
        average: round1(seconds.reduce((a, b) => a + b, 0) / seconds.length),
        median: round1(percentile(seconds, 50)),
        // p95 is the number that matters operationally: the average hides the
        // donations that took far too long, and those are the ones that spoil.
        p95: round1(percentile(seconds, 95)),
        fastest: round1(seconds[0]),
        slowest: round1(seconds[seconds.length - 1]),
      },
      offerRounds: {
        average: round2(rounds.reduce((a, b) => a + b, 0) / rounds.length),
        firstRoundRate: round1((rounds.filter((r) => r <= 1).length / rounds.length) * 100),
      },
      byCategory: Object.entries(byCategory).map(([category, v]) => ({
        category,
        matched: v.matched,
        avgSecondsToAccept: round1(v.totalSeconds / v.matched),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /analytics/agents/:agentId - one agent's totals, a single-row read.
export async function agentTotals(req, res, next) {
  try {
    const result = await getClient().execute(
      'SELECT agent_id, offered, accepted, declined, collected, timed_out FROM agent_totals WHERE agent_id = ?',
      [req.params.agentId],
      { prepare: true },
    );

    if (result.rowLength === 0) {
      return res.json({
        agentId: req.params.agentId,
        offered: 0, accepted: 0, declined: 0, collected: 0, timedOut: 0,
        acceptanceRate: null,
      });
    }

    const r = result.first();
    const offered = Number(r.offered ?? 0);
    const accepted = Number(r.accepted ?? 0);

    res.json({
      agentId: r.agent_id,
      offered,
      accepted,
      declined: Number(r.declined ?? 0),
      collected: Number(r.collected ?? 0),
      timedOut: Number(r.timed_out ?? 0),
      // The number that would feed a learned scoring model in v2: given that we
      // offered this agent a donation, how often did they take it?
      acceptanceRate: offered > 0 ? round1((accepted / offered) * 100) : null,
    });
  } catch (err) {
    next(err);
  }
}

// GET /analytics/recent?limit=50 - the live event feed for today.
export async function recent(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    // One partition (today), already sorted newest-first on disk by the
    // clustering order. No sort, no scan.
    const result = await getClient().execute(
      `SELECT occurred_at, event_id, donation_id, event_type, category, agent_id, score
       FROM events_by_day WHERE day = ? LIMIT ?`,
      [dayOf(new Date()), limit],
      { prepare: true },
    );

    res.json({
      day: dayOf(new Date()),
      events: result.rows.map((r) => ({
        occurredAt: r.occurred_at,
        donationId: r.donation_id,
        eventType: r.event_type,
        category: r.category,
        agentId: r.agent_id,
        score: r.score,
      })),
    });
  } catch (err) {
    next(err);
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

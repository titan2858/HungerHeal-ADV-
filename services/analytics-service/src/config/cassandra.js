import { Client, auth } from 'cassandra-driver';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Cassandra, and why it is here rather than more MongoDB.
//
// This service stores EVERY event forever. MongoDB already holds the current
// state of things - a donation's status, an agent's profile - and answers
// "what is true now?" well. This is a different question: "what happened, in
// order, over months?", with writes that only ever append and never update.
//
// That is the shape Cassandra is built for. Writes go to a commit log and a
// memtable with no read-before-write and no locking, so an append is cheap and
// stays cheap as the table grows past what one machine could hold.
//
// The cost, and it is a real one: YOU MUST KNOW YOUR QUERIES BEFORE YOU DESIGN
// YOUR TABLES. There are no ad-hoc joins, no arbitrary WHERE clauses, and no
// "we will add an index later". Each table below exists to answer one specific
// question, and the same event is written to several of them. In a relational
// database that duplication would be a normalisation error; here it is the
// design.
// ---------------------------------------------------------------------------

let client = null;
let ready = false;

export const isCassandraReady = () => ready;
export function getClient() {
  if (!client) throw new Error('cassandra is not initialised');
  return client;
}

const KEYSPACE = 'hungerheal';

export async function connectCassandra() {
  const options = {
    contactPoints: env.CASSANDRA_HOSTS.split(',').map((h) => h.trim()),
    localDataCenter: env.CASSANDRA_DATACENTER,
  };

  if (env.CASSANDRA_USER) {
    options.authProvider = new auth.PlainTextAuthProvider(env.CASSANDRA_USER, env.CASSANDRA_PASSWORD);
  }

  // Connected WITHOUT a keyspace first, because the keyspace may not exist yet.
  const bootstrap = new Client(options);
  await bootstrap.connect();

  // SimpleStrategy with one replica suits a single-node dev cluster.
  // NetworkTopologyStrategy with RF 3 is the production answer, and the comment
  // is here so the difference is a decision rather than an oversight.
  await bootstrap.execute(`
    CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  `);
  await bootstrap.shutdown();

  client = new Client({ ...options, keyspace: KEYSPACE });
  await client.connect();

  await createTables();

  ready = true;
  logger.info({ hosts: options.contactPoints, keyspace: KEYSPACE }, 'cassandra connected');
  return client;
}

async function createTables() {
  // ---------------------------------------------------------------- 1
  // Every event, partitioned by donation.
  //
  // PARTITION KEY (donation_id) puts a donation's whole history on one node, so
  // reading it is a single-partition read - the operation Cassandra is fastest
  // at. CLUSTERING BY (occurred_at, event_id) keeps it sorted on disk in the
  // order things happened, so "the story of this donation" needs no sort.
  //
  // event_id is in the clustering key as a tie-break: two events can share a
  // millisecond, and without it the second would silently overwrite the first,
  // because in Cassandra an INSERT on an existing primary key IS an update.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS donation_events (
      donation_id text,
      occurred_at timestamp,
      event_id text,
      event_type text,
      donor_id text,
      agent_id text,
      agent_name text,
      category text,
      status text,
      round int,
      score double,
      reason text,
      trace_id text,
      payload text,
      PRIMARY KEY ((donation_id), occurred_at, event_id)
    ) WITH CLUSTERING ORDER BY (occurred_at ASC, event_id ASC)
  `);

  // ---------------------------------------------------------------- 2
  // The same events again, partitioned by DAY.
  //
  // This is the duplication the header warns about, and the reason for it:
  // the table above cannot answer "what happened on Tuesday?" without scanning
  // every partition, which is the one thing Cassandra is worst at. A different
  // question needs a different table, keyed by how it will be asked.
  //
  // DESC ordering because every real query wants the most recent first.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events_by_day (
      day text,
      occurred_at timestamp,
      event_id text,
      donation_id text,
      event_type text,
      category text,
      agent_id text,
      score double,
      PRIMARY KEY ((day), occurred_at, event_id)
    ) WITH CLUSTERING ORDER BY (occurred_at DESC, event_id ASC)
  `);

  // ---------------------------------------------------------------- 3
  // One row per completed assignment, for time-to-accept analysis.
  //
  // Partitioned by day again, because "how fast did matching run last week?"
  // is a per-day question. Storing the seconds rather than two timestamps
  // means the read does no arithmetic.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS assignment_outcomes (
      day text,
      occurred_at timestamp,
      donation_id text,
      agent_id text,
      agent_name text,
      category text,
      urgency text,
      seconds_to_accept double,
      offer_rounds int,
      score double,
      search_radius_km double,
      PRIMARY KEY ((day), occurred_at, donation_id)
    ) WITH CLUSTERING ORDER BY (occurred_at DESC, donation_id ASC)
  `);

  // ---------------------------------------------------------------- 4
  // Per-agent counters.
  //
  // A COUNTER table, which Cassandra treats specially: counter columns can
  // only be incremented, never set, and cannot live alongside normal columns.
  // The payoff is that concurrent increments from several consumers do not
  // conflict - no read-modify-write, no lost updates.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_totals (
      agent_id text PRIMARY KEY,
      offered counter,
      accepted counter,
      declined counter,
      collected counter,
      timed_out counter
    )
  `);

  // ---------------------------------------------------------------- 5
  // Daily rollups, also counters.
  //
  // Pre-aggregated on write rather than computed on read. Cassandra has no
  // GROUP BY worth using across partitions, so the aggregate has to be
  // maintained as the events arrive.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS daily_totals (
      day text PRIMARY KEY,
      created counter,
      assigned counter,
      accepted counter,
      collected counter,
      unassigned counter,
      timed_out counter
    )
  `);

  logger.info('cassandra tables ready');
}

export async function disconnectCassandra() {
  if (client) {
    await client.shutdown().catch(() => {});
    ready = false;
  }
}

# Phase 0 — Infrastructure, and what Kafka/Redis actually are

Everything described here is running on your machine right now. Commands in
this doc are meant to be pasted and run, and the output compared.

```bash
docker compose up -d          # start Mongo, Redis, Kafka, Kafka UI
bash scripts/verify-infra.sh  # prove all three are usable (6 checks)
bash scripts/create-topics.sh # create the 8 HungerHeal topics
docker compose down           # stop (add -v to also wipe the data volumes)
```

---

## Why these four containers

| Container | Port (host) | Role in HungerHeal |
|---|---|---|
| `hh-mongo` | **27018** | Users (auth-service), donations (donation-service) |
| `hh-redis` | 6379 | Live agent locations, load counters, geocode cache, event dedup |
| `hh-kafka` | **29092** | The event bus every service communicates through |
| `hh-kafka-ui` | 8090 | Browser window into Kafka — a learning aid, not architecture |

Two ports are deliberately non-default:

- **Mongo is on 27018**, because this machine already runs a local `mongod` on
  27017. Inside the Docker network it is still `mongo:27017`.
- **Kafka is on 29092** for host clients. See "two listeners" below.

---

## Kafka, from zero

### The one-sentence version

Kafka is an append-only log that services write facts into and other services
read facts out of, at their own pace, without knowing about each other.

### Why not just have donation-service call assignment-engine directly?

A direct HTTP call means donation-service must know assignment-engine's
address, must wait for it, and **fails if it is down** — the donation is lost
even though the donor did everything right. With Kafka, donation-service
appends `donation.created` and is finished. If assignment-engine is restarting,
the event waits in the log and is processed on startup. Nothing is lost, and
donation-service does not even need to know assignment-engine exists.

That decoupling is also why adding analytics-service later (Phase 11) requires
**zero changes** to any existing service: it just starts reading the same
topics.

### Vocabulary, tied to this project

- **Broker** — a Kafka server process. `hh-kafka` is one broker. Production
  runs several; one is right for local dev.
- **Topic** — a named stream of events. `donation.created` is a topic. Think
  "a labelled log file you can only append to."
- **Partition** — each topic is split into partitions; this is Kafka's unit of
  parallelism. Our topics have **3 partitions**, so up to 3 instances of
  assignment-engine can process donations simultaneously.
- **Message key** — decides which partition a message lands on. We key every
  donation event by `donationId`. This matters: **ordering is guaranteed only
  within a partition.** Keying by donationId guarantees that for one donation,
  `created` then `assigned` then `accepted` then `collected` are processed in
  that order, while different donations still spread across partitions for
  throughput. Keying randomly would allow `accepted` to be processed before
  `assigned` for the same donation.
- **Offset** — a message's position in a partition. Consumers track "I have
  processed up to offset N."
- **Consumer group** — a set of consumer instances sharing the work of a topic;
  Kafka gives each partition to exactly one member. Two *different* groups
  reading the same topic each get **all** the messages — which is how
  notification-service and tracking-service both react to `donation.assigned`
  independently.
- **Retention** — Kafka keeps messages after they are read (7 days by
  default). Unlike a queue, reading does not consume. You can replay history.

### At-least-once delivery, and why it will bite you

Kafka guarantees a message is delivered *at least* once, not *exactly* once.
A consumer that crashes after doing its work but before committing its offset
will see the same message again on restart.

Concretely: assignment-engine could **assign the same donation twice**, or
tracking-service could increment an agent's load counter twice, making a free
agent look permanently busy.

The fix used throughout this project is a Redis dedup key — described below,
implemented in Phase 6.

### See it for yourself

```bash
# list topics
docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list

# inspect the partitions of one topic
docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe --topic donation.created

# watch a topic live (leave this running in one terminal)
docker exec -it hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic donation.created --from-beginning
```

Or open <http://localhost:8090> and click through the topics — while learning,
the visual view is worth more than the CLI.

> **Git Bash note:** arguments like `/opt/kafka/...` get rewritten into
> `C:/Program Files/Git/opt/kafka/...` before `docker exec` sees them, which
> fails with a confusing "no such file or directory". Run
> `export MSYS_NO_PATHCONV=1` first — the scripts in `scripts/` already do.

### Two listeners, one broker

A Kafka client's first connection asks the broker "where are you?", and the
broker replies with its *advertised* address. That reply has to be correct from
the caller's point of view, and "correct" differs by caller:

- a service **inside** Docker must be told `kafka:9092`
- a service **on your laptop** must be told `localhost:29092`

One address cannot satisfy both, so the broker exposes two listeners and
advertises a different hostname on each. This is the single most common Kafka
setup failure, and it is already handled in `docker-compose.yml`.

---

## Redis, from zero

Redis is an in-memory key-value store — RAM instead of disk, so lookups take
microseconds rather than milliseconds. HungerHeal uses it for four distinct
jobs.

### 1. Geospatial agent search — the main reason it is here

Finding "all agents within 5km of this donation" from MongoDB means loading
every agent and computing distance to each, which gets slower as agents are
added. Redis stores coordinates in a sorted set and answers radius queries
directly:

```bash
docker exec hh-redis redis-cli GEOADD agents:live 77.5946 12.9716 agent_1
docker exec hh-redis redis-cli GEOADD agents:live 72.8777 19.0760 agent_2
# who is within 5km of MG Road, Bengaluru? (nearest first, with distances)
docker exec hh-redis redis-cli GEOSEARCH agents:live FROMLONLAT 77.5946 12.9716 \
  BYRADIUS 5 km ASC WITHDIST
```

`agent_2` (Mumbai, ~850km away) is correctly not returned —
`verify-infra.sh` asserts exactly this. Note the argument order is
**longitude then latitude**, the reverse of how coordinates are usually
spoken. It is an easy and silent bug.

> `GEORADIUS` in the plan doc is the older command name; it is deprecated in
> favour of `GEOSEARCH`, which does the same job. This project uses
> `GEOSEARCH`.

### 2. Agent load counters

The scoring formula needs each agent's current pending-pickup count.
`INCR`/`DECR` on a Redis key is atomic, so two services adjusting the same
counter concurrently cannot lose an update:

```bash
docker exec hh-redis redis-cli INCR agent:agent_1:load   # on accepted assignment
docker exec hh-redis redis-cli DECR agent:agent_1:load   # on collected / rejected
```

### 3. Geocoding cache

OpenCage is rate-limited and slow relative to RAM, and the same address always
resolves to the same coordinates. Results are cached with a TTL (`SETEX`) so
the API is called only on a miss.

### 4. Idempotency keys — the fix for at-least-once delivery

`SETNX` ("set if not exists") returns 1 if it created the key and 0 if the key
was already there. That single atomic answer tells a consumer whether it has
already handled an event:

```bash
docker exec hh-redis redis-cli SETNX processed:evt-abc123 1   # -> 1, first time: do the work
docker exec hh-redis redis-cli SETNX processed:evt-abc123 1   # -> 0, redelivery: skip
```

The same primitive prevents two agents accepting one donation (Phase 6): the
first `SETNX` on `donation:<id>:claimed` wins, the second is told no.

---

## What Phase 0 deliberately does not include

No application code. The point is that every piece of the stack is proven to
run and be reachable *before* any feature depends on it — so when Phase 5
misbehaves, "is Kafka even up?" is already a settled question.

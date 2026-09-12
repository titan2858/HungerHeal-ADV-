#!/usr/bin/env bash
# Creates every Kafka topic HungerHeal uses. Safe to re-run (--if-not-exists).
#
# WHY 3 PARTITIONS: a partition is Kafka's unit of parallelism. One consumer
# instance can own a partition at a time, so 3 partitions = up to 3 instances
# of assignment-engine processing donations concurrently. Ordering is only
# guaranteed WITHIN a partition, which is exactly why producers key every
# message by donationId: all events for one donation land on the same
# partition and are therefore processed in order.
set -euo pipefail

# Git Bash (MSYS) rewrites arguments that look like absolute POSIX paths into
# Windows paths, which turns /opt/kafka/bin/... inside the container into
# C:/Program Files/Git/opt/kafka/bin/... and breaks `docker exec`. Disable that.
export MSYS_NO_PATHCONV=1

K="docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092"

TOPICS=(
  "donation.created"      # donation-service  -> assignment-engine
  "donation.assigned"     # assignment-engine -> notification-service, tracking-service
  "donation.timeout"      # tracking-service  -> assignment-engine (re-score next batch)
  "donation.accepted"     # tracking-service  -> load counter ++, offers cancelled
  "donation.collected"    # tracking-service  -> load counter --, terminal success
  "donation.rejected"     # tracking-service  -> load counter --, agent excluded from re-score
  "donation.unassigned"   # assignment-engine -> no agent found anywhere; donor told it is still pending
  "agent.location.updated" # agent-location-service -> analytics (Redis is the live source of truth)
)

for t in "${TOPICS[@]}"; do
  $K --create --if-not-exists --topic "$t" --partitions 3 --replication-factor 1 >/dev/null
  echo "  topic ready: $t"
done

echo
echo "All topics:"
$K --list | sed 's/^/  /'

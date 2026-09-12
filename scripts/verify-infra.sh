#!/usr/bin/env bash
# Phase 0 acceptance test: proves Mongo, Redis and Kafka are actually usable,
# not merely "container says running". Each check does a real read/write.
set -uo pipefail

# Git Bash (MSYS) rewrites arguments that look like absolute POSIX paths into
# Windows paths, which turns /opt/kafka/bin/... inside the container into
# C:/Program Files/Git/opt/kafka/bin/... and breaks `docker exec`. Disable that.
export MSYS_NO_PATHCONV=1

pass=0; fail=0
ok()   { echo "  [PASS] $1"; pass=$((pass+1)); }
bad()  { echo "  [FAIL] $1"; fail=$((fail+1)); }

echo "=============================================="
echo " HungerHeal Phase 0 — infrastructure check"
echo "=============================================="

echo
echo "1. MongoDB — write then read a document"
if docker exec hh-mongo mongosh --quiet \
     -u "${MONGO_ROOT_USER:-hungerheal}" -p "${MONGO_ROOT_PASSWORD:-hungerheal_dev_pw}" \
     --authenticationDatabase admin \
     --eval 'db.getSiblingDB("hh_smoke").probe.insertOne({at:new Date()}); print(db.getSiblingDB("hh_smoke").probe.countDocuments()>0 ? "MONGO_OK" : "MONGO_BAD")' 2>/dev/null | grep -q MONGO_OK; then
  ok "mongo insert + count"
  docker exec hh-mongo mongosh --quiet -u "${MONGO_ROOT_USER:-hungerheal}" -p "${MONGO_ROOT_PASSWORD:-hungerheal_dev_pw}" --authenticationDatabase admin --eval 'db.getSiblingDB("hh_smoke").dropDatabase()' >/dev/null 2>&1
else
  bad "mongo insert + count"
fi

echo
echo "2. Redis — SET/GET, and the GEO commands the matching engine depends on"
if docker exec hh-redis redis-cli SET hh:smoke "alive" >/dev/null 2>&1 \
   && [ "$(docker exec hh-redis redis-cli GET hh:smoke 2>/dev/null | tr -d '\r')" = "alive" ]; then
  ok "redis SET/GET"
else
  bad "redis SET/GET"
fi

# The real reason Redis is in this stack: geospatial radius search for agents.
docker exec hh-redis redis-cli DEL hh:smoke:geo >/dev/null 2>&1
docker exec hh-redis redis-cli GEOADD hh:smoke:geo 77.5946 12.9716 agent_bengaluru >/dev/null 2>&1
docker exec hh-redis redis-cli GEOADD hh:smoke:geo 77.6100 12.9800 agent_nearby     >/dev/null 2>&1
docker exec hh-redis redis-cli GEOADD hh:smoke:geo 72.8777 19.0760 agent_mumbai     >/dev/null 2>&1
found=$(docker exec hh-redis redis-cli GEOSEARCH hh:smoke:geo FROMLONLAT 77.5946 12.9716 BYRADIUS 5 km ASC 2>/dev/null | tr -d '\r' | tr '\n' ',' )
if echo "$found" | grep -q "agent_nearby" && ! echo "$found" | grep -q "agent_mumbai"; then
  ok "redis GEOSEARCH found nearby agents within 5km and correctly excluded the 850km-away one"
  echo "         -> returned: ${found%,}"
else
  bad "redis GEOSEARCH radius query (got: ${found:-nothing})"
fi
docker exec hh-redis redis-cli DEL hh:smoke:geo hh:smoke >/dev/null 2>&1

echo
echo "3. Kafka — produce a message and consume it back"
TOPIC="hh.smoke.$(date +%s)"
docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --if-not-exists --topic "$TOPIC" --partitions 1 --replication-factor 1 >/dev/null 2>&1
if docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null | grep -q "$TOPIC"; then
  ok "kafka topic created ($TOPIC)"
else
  bad "kafka topic create"
fi

echo '{"event":"smoke","donationId":"probe-1"}' | \
  docker exec -i hh-kafka /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 --topic "$TOPIC" >/dev/null 2>&1

got=$(docker exec hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic "$TOPIC" \
  --from-beginning --max-messages 1 --timeout-ms 15000 2>/dev/null | tr -d '\r')
if echo "$got" | grep -q "probe-1"; then
  ok "kafka produce -> consume round trip"
  echo "         -> consumed: $got"
else
  bad "kafka produce -> consume round trip (got: ${got:-nothing})"
fi
docker exec hh-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --delete --topic "$TOPIC" >/dev/null 2>&1

echo
echo "4. Kafka UI reachable on http://localhost:8090"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:8090 2>/dev/null)
if [ "$code" = "200" ] || [ "$code" = "302" ]; then ok "kafka-ui HTTP $code"; else bad "kafka-ui HTTP ${code:-no response}"; fi

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

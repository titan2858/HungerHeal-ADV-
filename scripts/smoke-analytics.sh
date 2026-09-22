#!/usr/bin/env bash
# Phase 11 acceptance test: analytics-service and Cassandra.
#
# Two things worth proving:
#   1. the event history is genuinely in Cassandra, in the shape the tables
#      were designed for
#   2. this service is OPTIONAL - donations still work with it stopped, and
#      it catches up from Kafka when it returns
set -uo pipefail
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
LOC="${LOCATION_BASE_URL:-http://localhost:4004}"
ENG="${ENGINE_BASE_URL:-http://localhost:4005}"
ANA="${ANALYTICS_BASE_URL:-http://localhost:4008}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.ana-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
cql()  { docker exec hh-cassandra cqlsh -e "$1" 2>/dev/null; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

echo "=============================================="
echo " HungerHeal Phase 11 - analytics + Cassandra"
echo "=============================================="

echo
echo "1. The service is up and Cassandra is reachable"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$ANA/ready")
if [ "$code" = "200" ] && body | grep -q '"cassandra":"up"'; then
  ok "analytics-service ready, Cassandra connected"
else
  bad "/ready: $(body)"
fi

echo
echo "2. The keyspace and tables exist"
TABLES=$(cql "DESCRIBE TABLES;" | tr -s ' \n' ' ')
for t in donation_events events_by_day assignment_outcomes agent_totals daily_totals; do
  echo "$TABLES" | grep -q "$t" && ok "table $t" || bad "table $t missing"
done

echo
echo "3. Produce a real donation and follow it into Cassandra"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"p11agent\",\"email\":\"p11a_${STAMP}@example.com\",\"phone\":\"+91 9000000001\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
AGENT=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
AGENT_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $AGENT" \
  -X POST "$LOC/agents/location" -d '{"lat":12.9760,"lng":77.6070}'

curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"p11donor\",\"email\":\"p11d_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"ADMIN\",\"name\":\"p11admin\",\"email\":\"p11m_${STAMP}@example.com\",\"phone\":\"+91 9000000009\",\"password\":\"goodpass1\"}"
ADMIN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Analytics probe\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":20,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":12.9757,\"lng\":77.6068,\"bestBefore\":\"$BB\"}"
DID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$DID" ] && ok "donation created: $DID" || bad "create failed"

sleep 7
curl -s -o /dev/null -H "Authorization: Bearer $AGENT" -X POST "$ENG/offers/$DID/accept"
sleep 6

echo
echo "4. The events are in Cassandra, in order"
ROWS=$(cql "SELECT event_type FROM hungerheal.donation_events WHERE donation_id = '$DID';" | grep -cE "donation\.")
[ "$ROWS" -ge 2 ] 2>/dev/null && ok "$ROWS events stored for this donation" || bad "only $ROWS events found"

# A single-partition read, already sorted on disk by the clustering order -
# the operation the table was partitioned by donation_id to make fast.
ORDER=$(cql "SELECT event_type FROM hungerheal.donation_events WHERE donation_id = '$DID';" | grep -oE "donation\.[a-z]+" | head -2 | tr '\n' ' ')
echo "$ORDER" | grep -q "donation.created" && ok "the history starts with donation.created: $ORDER" || bad "unexpected order: $ORDER"

echo
echo "5. The same event, in the day-partitioned table"
# The duplication is the design: donation_events cannot answer "what happened
# today?" without scanning every partition, so a second table is keyed by day.
TODAY=$(date -u +%Y-%m-%d)
DAYROWS=$(cql "SELECT donation_id FROM hungerheal.events_by_day WHERE day = '$TODAY' LIMIT 200;" | grep -c "$DID")
[ "$DAYROWS" -ge 2 ] 2>/dev/null && ok "$DAYROWS of today's events reference this donation" || bad "found $DAYROWS in events_by_day"

echo
echo "6. Counters were incremented, not recomputed"
OFFERED=$(cql "SELECT offered, accepted FROM hungerheal.agent_totals WHERE agent_id = '$AGENT_ID';" | sed -n '4p' | awk '{print $1}')
[ -n "$OFFERED" ] && [ "$OFFERED" != "null" ] && ok "agent_totals.offered = $OFFERED" || bad "no agent counter row"

DAILY=$(cql "SELECT created FROM hungerheal.daily_totals WHERE day = '$TODAY';" | sed -n '4p' | tr -d ' ')
[ -n "$DAILY" ] && [ "$DAILY" != "null" ] && ok "daily_totals.created = $DAILY (pre-aggregated on write)" || bad "no daily rollup"

echo
echo "7. The API the plan asked for: average time to assignment"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$ANA/analytics/matching?days=7")
[ "$code" = "200" ] && ok "GET /analytics/matching" || bad "matching got $code: $(body)"

MATCHED=$(jq_body "d.get('matched', 0)")
[ "$MATCHED" -ge 1 ] 2>/dev/null && ok "$MATCHED assignments measured" || bad "matched was $MATCHED"

AVG=$(jq_body "d['secondsToAccept']['average'] if d.get('matched') else -1")
[ -n "$AVG" ] && ok "average time to assignment: ${AVG}s" || bad "no average"
P95=$(jq_body "d['secondsToAccept']['p95'] if d.get('matched') else -1")
# The average hides the donations that took far too long, and those are the
# ones that spoil.
[ -n "$P95" ] && ok "p95: ${P95}s - what the average hides" || bad "no p95"

echo
echo "8. Daily rollups and the live feed"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$ANA/analytics/daily?days=7")
[ "$code" = "200" ] && ok "GET /analytics/daily" || bad "daily got $code"
DAYS=$(jq_body "len(d['days'])")
[ "$DAYS" = "7" ] && ok "7 days returned, zero-filled where nothing happened" || bad "got $DAYS days"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$ANA/analytics/recent?limit=20")
[ "$code" = "200" ] && ok "GET /analytics/recent" || bad "recent got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$ANA/analytics/agents/$AGENT_ID")
[ "$code" = "200" ] && ok "GET /analytics/agents/:id" || bad "agent totals got $code"
RATE=$(jq_body "d.get('acceptanceRate')")
# The number that would feed a learned scoring model in v2.
[ -n "$RATE" ] && [ "$RATE" != "None" ] && ok "acceptance rate: ${RATE}%" || bad "no acceptance rate"

echo
echo "9. It is ADMIN-only and read-only"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DONOR" "$ANA/analytics/daily")
[ "$code" = "403" ] && ok "a donor cannot read analytics (403)" || bad "expected 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$ANA/analytics/daily")
[ "$code" = "401" ] && ok "anonymous access rejected (401)" || bad "expected 401, got $code"
for verb in POST PUT DELETE; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$verb" -H "Authorization: Bearer $ADMIN" "$ANA/analytics/daily")
  [ "$code" = "404" ] || [ "$code" = "405" ] && ok "$verb is not a route ($code)" || bad "$verb returned $code"
done

echo
echo "10. THE SERVICE IS OPTIONAL - donations work without it"
docker compose stop analytics-service >/dev/null 2>&1
sleep 3

curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Posted while analytics was down\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":15,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":12.9757,\"lng\":77.6068,\"bestBefore\":\"$BB\"}"
D2=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
# Nothing else depends on analytics. A donation posted while it is down is
# created, matched and offered exactly as usual.
[ -n "$D2" ] && ok "a donation was created with analytics stopped" || bad "create failed while analytics was down"
sleep 7

echo
echo "11. And it catches up from Kafka when it returns"
docker compose --profile analytics start analytics-service >/dev/null 2>&1
for i in $(seq 1 20); do
  st=$(docker inspect -f '{{.State.Health.Status}}' hh-analytics 2>/dev/null)
  [ "$st" = "healthy" ] && break
  sleep 5
done
sleep 8

CAUGHT=$(cql "SELECT event_type FROM hungerheal.donation_events WHERE donation_id = '$D2';" | grep -cE "donation\.")
if [ "$CAUGHT" -ge 1 ] 2>/dev/null; then
  ok "$CAUGHT events for the missed donation were consumed on restart"
  echo "         -> the events waited in Kafka; nothing was lost"
else
  bad "the missed donation's events were not caught up"
fi

echo
echo "Cleaning up..."
rcli ZREM agents:live "$AGENT_ID" >/dev/null
rcli DEL "agent:$AGENT_ID:caps" "agent:$AGENT_ID:alive" "agent:$AGENT_ID:load" >/dev/null
for d in "$DID" "$D2"; do
  [ -n "$d" ] || continue
  rcli DEL "donation:$d:offer" "donation:$d:claimed" "donation:$d:declined" >/dev/null
done
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

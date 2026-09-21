#!/usr/bin/env bash
# Phase 5 acceptance test: the whole chain, end to end.
#
#   donor posts a donation
#     -> donation-service publishes donation.created
#       -> assignment-engine consumes it
#         -> GEOSEARCH finds nearby agents in Redis
#           -> scores them
#             -> publishes donation.assigned with the top 3
#
# No human touches any part of that. This script proves it by reading the
# resulting event back out of Kafka and checking WHICH agent was ranked first
# and WHY.
set -uo pipefail
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
LOC="${LOCATION_BASE_URL:-http://localhost:4004}"
ENG="${ENGINE_BASE_URL:-http://localhost:4005}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.asg-body.$$"
EVT="./.asg-evt.$$"
trap 'rm -f "$BODY" "$EVT"' EXIT
body() { cat "$BODY"; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }

# The donation pickup point: MG Road, Bengaluru.
PLAT=12.9757
PLNG=77.6068

# Registers an agent, reports their position, echoes "<token> <id>".
place_agent() {
  local label="$1" cats="$2" insulated="$3" lat="$4" lng="$5"
  curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"role\":\"AGENT\",\"name\":\"$label\",\"email\":\"${label}_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":$insulated,\"categoriesHandled\":$cats}}"
  local tok id
  tok=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
  id=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)

  curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
    -X POST "$LOC/agents/location" -d "{\"lat\":$lat,\"lng\":$lng}"

  echo "$tok $id"
}

# Reads donation.assigned (or another topic) looking for a donation id.
read_event() {
  local topic="$1" needle="$2" timeout="${3:-20000}"
  docker exec hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 --topic "$topic" \
    --from-beginning --timeout-ms "$timeout" 2>/dev/null | grep "$needle" | tail -1
}

# Pulls a JSON value out of the event with python, since the payload is nested.
jq_py() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$EVT" 2>/dev/null; }

echo "=============================================="
echo " HungerHeal Phase 5 - assignment-engine"
echo "=============================================="

echo
echo "1. The engine is running"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$ENG/health")
[ "$code" = "200" ] && ok "GET /health" || bad "health got $code"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$ENG/ready")
if [ "$code" = "200" ] && body | grep -q '"redis":"up"'; then
  ok "GET /ready - redis reachable, consumer group $(body | sed -n 's/.*"consumerGroup":"\([^"]*\)".*/\1/p')"
else
  bad "/ready: $(body)"
fi

echo
echo "2. Put five agents on the map around MG Road"
# Closest of all, but only carries packaged goods - must be filtered out.
read -r WRONG_TOKEN WRONG_ID < <(place_agent "wrongcat" '["PACKAGED_NON_PERISHABLE"]' false 12.9765 77.6075)
# Very close, carries cooked food, but has NO insulated box.
read -r BARE_TOKEN BARE_ID < <(place_agent "barenear" '["COOKED_PREPARED"]' false 12.9780 77.6080)
# Farther away, but properly equipped. Should win on compatibility.
read -r EQUIP_TOKEN EQUIP_ID < <(place_agent "equipped" '["COOKED_PREPARED"]' true 12.9850 77.6150)
# Two more cooked-capable agents further out, so FOUR agents are eligible and
# the top-3 cap has something to actually cap.
read -r SPARE1_TOKEN SPARE1_ID < <(place_agent "spareone" '["COOKED_PREPARED"]' false 12.9950 77.6250)
read -r SPARE2_TOKEN SPARE2_ID < <(place_agent "sparetwo" '["COOKED_PREPARED"]' false 13.0050 77.6350)

[ -n "$EQUIP_ID" ] && ok "five agents registered and reporting positions" || bad "agent setup failed"
echo "         -> packaged-only ~0.1km | bare ~0.3km | equipped ~1.4km | 2 spares further out"
echo "         -> four of the five carry cooked food, so the top-3 cap applies"

# The engine reads Redis directly, so confirm the data is actually there.
[ -n "$(rcli ZSCORE agents:live "$EQUIP_ID")" ] && ok "agents visible in the Redis geo set" || bad "agents missing from Redis"

echo
echo "3. A donor posts cooked food - and nothing else happens by hand"
BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"Asha\",\"email\":\"asgdonor_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

TRACE="phase5-smoke-$STAMP"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -H "x-trace-id: $TRACE" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Leftover biryani\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":40,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":$PLAT,\"lng\":$PLNG,\"bestBefore\":\"$BB\"}")
DONATION_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ "$code" = "201" ] && [ -n "$DONATION_ID" ] && ok "donation created: $DONATION_ID" || bad "create got $code: $(body)"

echo
echo "4. THE ENGINE ASSIGNED IT AUTOMATICALLY"
echo "   waiting for donation.assigned on Kafka..."
sleep 3
read_event "donation.assigned" "$DONATION_ID" 25000 > "$EVT"

if [ -s "$EVT" ]; then
  ok "donation.assigned event published - no admin involved at any point"
else
  bad "no donation.assigned event appeared for $DONATION_ID"
fi

OFFER_COUNT=$(jq_py "len(d['offers'])")
# Four agents are eligible; exactly three are offered. One event, three agents.
[ "$OFFER_COUNT" = "3" ] && ok "3 agents offered in ONE event (parallel offers, capped from 4 eligible)" || bad "expected 3 offers, got '${OFFER_COUNT:-none}'"
ELIGIBLE=$(jq_py "d['candidatesEligible']")
[ "$ELIGIBLE" = "4" ] && ok "the event records that 4 were eligible and 3 were chosen" || bad "candidatesEligible was $ELIGIBLE"

echo
echo "5. Was the RIGHT agent chosen?"
TOP_ID=$(jq_py "d['offers'][0]['agentId']")
TOP_NAME=$(jq_py "d['offers'][0]['agentName']")
TOP_SCORE=$(jq_py "d['offers'][0]['score']")

echo "         -> ranked: $(jq_py "', '.join('%s(%.3f)' % (o['agentName'], o['score']) for o in d['offers'])")"

if [ "$TOP_ID" = "$EQUIP_ID" ]; then
  ok "the INSULATED agent 1.4km away beat the bare agent 0.3km away (score $TOP_SCORE)"
  echo "         -> this is the whole point: distance is 35% of the decision, not all of it"
else
  bad "expected the equipped agent to rank first, got $TOP_NAME"
fi

# Ranked ordering.
ORDERED=$(jq_py "all(d['offers'][i]['score'] >= d['offers'][i+1]['score'] for i in range(len(d['offers'])-1))")
[ "$ORDERED" = "True" ] && ok "offers are ordered best-first" || bad "offers are not sorted by score"

RANKS=$(jq_py "[o['rank'] for o in d['offers']]")
[ "$RANKS" = "[1, 2, 3]" ] && ok "offers carry ranks 1..3" || bad "ranks were $RANKS"

echo
echo "6. Is the decision EXPLAINABLE?"
DIST_S=$(jq_py "d['offers'][0]['breakdown']['distanceScore']")
CAT_S=$(jq_py "d['offers'][0]['breakdown']['categoryScore']")
LOAD_S=$(jq_py "d['offers'][0]['breakdown']['loadScore']")
RATE_S=$(jq_py "d['offers'][0]['breakdown']['ratingScore']")
echo "         -> winner's terms: distance=$DIST_S category=$CAT_S load=$LOAD_S rating=$RATE_S"

[ -n "$DIST_S" ] && [ -n "$CAT_S" ] && ok "every scoring term is carried on the event" || bad "breakdown incomplete"

# The parts must add up to the whole, or the explanation is fiction.
ADDS_UP=$(jq_py "abs(d['offers'][0]['breakdown']['total'] - (d['offers'][0]['breakdown']['weightedDistance']+d['offers'][0]['breakdown']['weightedCategory']+d['offers'][0]['breakdown']['weightedLoad']+d['offers'][0]['breakdown']['weightedRating'])) < 1e-4")
[ "$ADDS_UP" = "True" ] && ok "the weighted parts sum exactly to the total" || bad "breakdown does not add up"

# The equipped agent should score 1.0 on category; the bare one should not.
BARE_CAT=$(jq_py "[o['breakdown']['categoryScore'] for o in d['offers'] if o['agentId']=='$BARE_ID'][0]")
if [ -n "$BARE_CAT" ] && python -c "import sys; sys.exit(0 if float('$BARE_CAT') < float('$CAT_S') else 1)"; then
  ok "the agent without an insulated box scored lower on compatibility ($BARE_CAT vs $CAT_S)"
else
  bad "compatibility did not differentiate the two agents"
fi

echo
echo "7. Category is a HARD filter"
HAS_WRONG=$(jq_py "any(o['agentId']=='$WRONG_ID' for o in d['offers'])")
# The packaged-only agent was the CLOSEST of all three. A score penalty would
# still have let them win; exclusion is the only correct handling.
[ "$HAS_WRONG" = "False" ] && ok "the closest agent was excluded entirely - they do not carry cooked food" || bad "an ineligible agent was offered the donation"

echo
echo "8. Urgency sets the deadline, not the score"
TIMEOUT=$(jq_py "d['responseTimeoutSeconds']")
URGENCY=$(jq_py "d['urgency']")
[ "$TIMEOUT" = "90" ] && ok "cooked food gets a 90s response window" || bad "timeout was $TIMEOUT"
[ "$URGENCY" = "HIGH" ] && ok "urgency recorded as HIGH" || bad "urgency was $URGENCY"

RADIUS=$(jq_py "d['searchRadiusKm']")
ATTEMPTS=$(jq_py "d['radiusAttempts']")
[ "$ATTEMPTS" = "1" ] && ok "found at the first 5km radius (no widening needed)" || bad "took $ATTEMPTS radius attempts"

echo
echo "9. Trace propagation through the event pipeline"
EVENT_TRACE=$(jq_py "d['traceId']")
# HTTP request -> Mongo -> donation.created -> engine -> donation.assigned.
[ "$EVENT_TRACE" = "$TRACE" ] && ok "the donor's traceId survived all the way to donation.assigned" || bad "trace was '$EVENT_TRACE', expected '$TRACE'"

echo
echo "10. A donation nobody can collect is announced, not dropped"
# Mumbai - 850km from every agent we placed.
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Food with no agents nearby\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":5,\"quantityUnit\":\"KG\",\"pickupAddress\":\"Bandra West, Mumbai\",\"lat\":19.0760,\"lng\":72.8777,\"bestBefore\":\"$BB\"}")
LONELY_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ "$code" = "201" ] && ok "donation created in a city with no agents" || bad "create got $code"

sleep 3
read_event "donation.unassigned" "$LONELY_ID" 25000 > "$EVT"
if [ -s "$EVT" ]; then
  ok "donation.unassigned published - the donation did not silently disappear"
  echo "         -> reason: $(jq_py "d['reason']") | retryable: $(jq_py "d['retryable']")"
else
  bad "no donation.unassigned event for $LONELY_ID"
fi
REASON=$(jq_py "d['reason']")
[ "$REASON" = "NO_AGENTS_FOUND" ] && ok "reason is machine-readable: NO_AGENTS_FOUND" || bad "reason was $REASON"
RETRYABLE=$(jq_py "d['retryable']")
# Agents come online continuously, so this one IS worth retrying.
[ "$RETRYABLE" = "True" ] && ok "marked retryable - agents may come online later" || bad "retryable was $RETRYABLE"
SEARCHED=$(jq_py "d['searchedRadiusKm']")
[ "$SEARCHED" = "50.0" ] || [ "$SEARCHED" = "50" ] && ok "the search widened all the way to 50km before giving up" || bad "searched only $SEARCHED km"

echo
echo "11. Tinned goods prefer the plain nearby agent"
# The packaged-only agent from step 2 is both plain and closer than either
# agent below, so it would legitimately win and tell us nothing. Remove it so
# this test compares exactly one thing: plain vs equipped, at equal distance.
rcli ZREM agents:live "$WRONG_ID" >/dev/null
rcli DEL "agent:$WRONG_ID:alive" >/dev/null
# The mirror of test 5: for food that needs no special transport, the insulated
# agent is scored DOWN so they stay free for food that does.
read -r PLAIN_TOKEN PLAIN_ID < <(place_agent "plaincycle" '["PACKAGED_NON_PERISHABLE"]' false 12.9780 77.6080)
read -r VAN_TOKEN VAN_ID < <(place_agent "fridgevan" '["PACKAGED_NON_PERISHABLE"]' true 12.9782 77.6082)

code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Tinned goods\",\"category\":\"PACKAGED_NON_PERISHABLE\",\"quantityAmount\":20,\"quantityUnit\":\"KG\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":$PLAT,\"lng\":$PLNG,\"bestBefore\":\"$BB\"}")
TINNED_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)

sleep 3
read_event "donation.assigned" "$TINNED_ID" 25000 > "$EVT"
if [ -s "$EVT" ]; then
  TIN_TOP=$(jq_py "d['offers'][0]['agentId']")
  TIN_TIMEOUT=$(jq_py "d['responseTimeoutSeconds']")
  if [ "$TIN_TOP" = "$PLAIN_ID" ]; then
    ok "the plain agent won the tinned goods - the equipped van stays free for hot food"
  else
    bad "expected the plain agent to win tinned goods, got $(jq_py "d['offers'][0]['agentName']")"
  fi
  [ "$TIN_TIMEOUT" = "300" ] && ok "tinned goods get a 5 minute window, not 90 seconds" || bad "timeout was $TIN_TIMEOUT"
else
  bad "no assignment event for the tinned donation"
fi

echo
echo "Cleaning up the agents this run created..."
for id in "$WRONG_ID" "$BARE_ID" "$EQUIP_ID" "$PLAIN_ID" "$VAN_ID" "$SPARE1_ID" "$SPARE2_ID"; do
  [ -n "$id" ] || continue
  rcli ZREM agents:live "$id" >/dev/null
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

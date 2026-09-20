#!/usr/bin/env bash
# Phase 4 acceptance test: agent-location-service against the running stack.
#
# It asserts on the RAW REDIS STRUCTURES as well as the HTTP responses, because
# the shape of that data is the contract assignment-engine reads directly in
# Phase 5 - it will not go through this service's HTTP layer on the hot path.
set -uo pipefail
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
LOC="${LOCATION_BASE_URL:-http://localhost:4004}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.loc-body.$$"
trap 'rm -f "$BODY"' EXIT
req()  { curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
body() { cat "$BODY"; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }

# Signs up an agent and echoes "<token> <userId>".
make_agent() {
  local label="$1" cats="$2" insulated="$3"
  curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"role\":\"AGENT\",\"name\":\"$label\",\"email\":\"${label// /_}_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":$insulated,\"categoriesHandled\":$cats}}"
  local tok id
  tok=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
  id=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
  echo "$tok $id"
}

# Reports a location for an agent token.
report() {
  curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $1" -X POST "$LOC/agents/location" \
    -d "{\"lat\":$2,\"lng\":$3}"
}

echo "=============================================="
echo " HungerHeal Phase 4 - agent-location-service"
echo "=============================================="

echo
echo "1. Service reachable"
[ "$(req "$LOC/health")" = "200" ] && ok "GET /health" || bad "health failed"
code=$(req "$LOC/ready")
if [ "$code" = "200" ] && body | grep -q '"redis":"up"'; then
  ok "GET /ready - redis up ($(body | sed -n 's/.*"agentsTracked":\([0-9]*\).*/\1 agents tracked/p'))"
else
  bad "/ready: $(body)"
fi

echo
echo "2. Authorization"
code=$(req -X POST "$LOC/agents/location" -d '{"lat":12.97,"lng":77.60}')
[ "$code" = "401" ] && ok "unauthenticated location report rejected (401)" || bad "expected 401, got $code"

read -r DONOR_TOKEN _ < <(
  curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"role\":\"DONOR\",\"name\":\"Donor\",\"email\":\"locdonor_${STAMP}@example.com\",\"phone\":\"+91 9000000009\",\"password\":\"goodpass1\"}"
  echo "$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY") x"
)
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$LOC/agents/location" -d '{"lat":12.97,"lng":77.60}')
# Only an agent has a location worth tracking.
[ "$code" = "403" ] && ok "a donor cannot report an agent location (403)" || bad "expected 403, got $code"

echo
echo "3. An agent reports a position"
read -r A1_TOKEN A1_ID < <(make_agent "Ravi Near" '["COOKED_PREPARED","BAKERY"]' true)
[ -n "$A1_ID" ] && ok "agent registered ($A1_ID)" || bad "agent signup failed"

# MG Road, Bengaluru.
code=$(report "$A1_TOKEN" 12.9757 77.6068)
[ "$code" = "200" ] && ok "location accepted (200)" || bad "location report got $code: $(body)"
body | grep -q 'expiresInSeconds' && ok "response tells the client when the heartbeat lapses" || bad "no ttl hint returned"

echo
echo "4. THE RAW REDIS STRUCTURES (what assignment-engine reads in Phase 5)"
score=$(rcli ZSCORE agents:live "$A1_ID")
[ -n "$score" ] && ok "GEOADD: agent is a member of the agents:live geo set" || bad "agent missing from geo set"

pos=$(rcli GEOPOS agents:live "$A1_ID" | tr '\n' ' ')
echo "         -> GEOPOS: $pos"
echo "$pos" | grep -q "77.60" && ok "stored longitude looks right (lng first, as GEOADD requires)" || bad "coordinate order suspect: $pos"

cats=$(rcli HGET "agent:$A1_ID:caps" categories)
[ "$cats" = "COOKED_PREPARED,BAKERY" ] && ok "capabilities mirrored from auth-service into Redis" || bad "capabilities hash wrong: '$cats'"
ins=$(rcli HGET "agent:$A1_ID:caps" insulated)
[ "$ins" = "1" ] && ok "insulated-transport flag mirrored (scoring input)" || bad "insulated flag was '$ins'"
rating=$(rcli HGET "agent:$A1_ID:caps" rating)
[ "$rating" = "3.50" ] && ok "neutral 3.50 rating carried across from auth-service" || bad "rating was '$rating'"

ttl=$(rcli TTL "agent:$A1_ID:alive")
if [ "$ttl" -gt 0 ] 2>/dev/null; then
  ok "heartbeat key has a TTL of ${ttl}s - the workaround for geo members not expiring"
else
  bad "heartbeat TTL was '$ttl'"
fi
capsttl=$(rcli TTL "agent:$A1_ID:caps")
# -1 means "no expiry". Capabilities are not presence: an agent offline for a
# week has not stopped owning an insulated box.
[ "$capsttl" = "-1" ] && ok "capabilities deliberately have NO TTL" || bad "caps TTL was '$capsttl'"

echo
echo "5. The radius query"
read -r A2_TOKEN A2_ID < <(make_agent "Priya Far" '["COOKED_PREPARED"]' true)
report "$A2_TOKEN" 19.0760 72.8777 >/dev/null   # Mumbai, ~850km away

read -r A3_TOKEN A3_ID < <(make_agent "Sunil Packaged" '["PACKAGED_NON_PERISHABLE"]' false)
report "$A3_TOKEN" 12.9756 77.6033 >/dev/null   # Church Street, ~380m away

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" \
  "$LOC/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5")
[ "$code" = "200" ] && ok "GET /agents/nearby" || bad "nearby got $code"
echo "         -> $(body | cut -c1-160)..."

body | grep -q "$A1_ID" && ok "the nearby agent was found" || bad "nearby agent missing"
body | grep -q "$A2_ID" && bad "the Mumbai agent should NOT be within 5km" || ok "the 850km-away agent was correctly excluded"
body | grep -q '"distanceKm"' && ok "distance computed by Redis, not in application code" || bad "no distance returned"

echo
echo "6. Category is a HARD filter, not a score penalty"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" \
  "$LOC/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5&category=COOKED_PREPARED")
body | grep -q "$A1_ID" && ok "an agent who handles cooked food is returned" || bad "cooked-food agent missing"
# Offering cooked food to someone who only carries packaged goods is never
# right, however close they are.
body | grep -q "$A3_ID" && bad "the packaged-only agent should be filtered out" || ok "the packaged-only agent was excluded"

echo
echo "7. Availability toggle"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $A1_TOKEN" -X POST "$LOC/agents/availability" -d '{"available":false}')
[ "$code" = "200" ] && ok "agent marked unavailable" || bad "availability got $code"

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$LOC/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5" >/dev/null
body | grep -q "$A1_ID" && bad "an unavailable agent must not be matched" || ok "unavailable agent excluded from matching"

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$LOC/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5&includeUnavailable=true" >/dev/null
body | grep -q "$A1_ID" && ok "but still visible to a monitoring view" || bad "includeUnavailable did not return them"

curl -s -H 'Content-Type: application/json' -H "Authorization: Bearer $A1_TOKEN" \
  -X POST "$LOC/agents/availability" -d '{"available":true}' >/dev/null

echo
echo "8. The load counter that feeds scoring"
curl -s -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR_TOKEN" \
  -X POST "$LOC/agents/$A1_ID/load" -d '{"delta":1}' >/dev/null
curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR_TOKEN" \
  -X POST "$LOC/agents/$A1_ID/load" -d '{"delta":1}' >/dev/null
body | grep -q '"currentLoad":2' && ok "load incremented atomically to 2" || bad "load was $(body)"

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$LOC/agents/nearby?lat=12.9757&lng=77.6068&radiusKm=5" >/dev/null
# Everything scoring needs must arrive in ONE query, or the engine makes a
# round trip per candidate.
body | grep -q '"currentLoad":2' && ok "load returned inline with the nearby results" || bad "load not in nearby payload"
body | grep -q '"rating"' && ok "rating returned inline" || bad "rating not in nearby payload"
body | grep -q '"hasInsulatedTransport"' && ok "transport capability returned inline" || bad "capabilities not in nearby payload"

echo
echo "9. Validation"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $A1_TOKEN" -X POST "$LOC/agents/location" -d '{"lat":91,"lng":77}')
[ "$code" = "400" ] && ok "latitude out of range rejected (400)" || bad "expected 400, got $code"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $A1_TOKEN" -X POST "$LOC/agents/location" -d '{"lat":12.97}')
[ "$code" = "400" ] && ok "missing longitude rejected (400)" || bad "expected 400, got $code"

echo
echo "10. Signing off removes the agent immediately"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $A1_TOKEN" -X POST "$LOC/agents/offline")
[ "$code" = "200" ] && ok "agent went offline" || bad "offline got $code"
[ -z "$(rcli ZSCORE agents:live "$A1_ID")" ] && ok "removed from the geo set at once, not after the TTL" || bad "still in the geo set"
# Capabilities survive, so coming back online costs no auth-service call.
[ "$(rcli HGET "agent:$A1_ID:caps" categories)" = "COOKED_PREPARED,BAKERY" ] && ok "capabilities survive a sign-off" || bad "capabilities were destroyed"

echo
echo "11. Trace propagation across languages"
tid=$(curl -s -D - -o /dev/null -H 'x-trace-id: phase4-trace-xyz' "$LOC/health" | grep -i '^x-trace-id' | tr -d '\r' | awk '{print $2}')
[ "$tid" = "phase4-trace-xyz" ] && ok "the Go service reuses an incoming traceId, like the Node ones" || bad "trace id was '$tid'"

# Leave the shared geo set as it was found.
rcli ZREM agents:live "$A1_ID" "$A2_ID" "$A3_ID" >/dev/null
for id in "$A1_ID" "$A2_ID" "$A3_ID"; do
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

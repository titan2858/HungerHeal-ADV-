#!/usr/bin/env bash
# Phase 10 acceptance test: the read-only monitoring view.
#
# Two things are being proven:
#   1. the algorithm's reasoning is inspectable - every candidate's score with
#      its four weighted terms, exactly as computed at decision time
#   2. the view is READ-ONLY - there is no assign or reassign endpoint, which
#      is the plan's central non-negotiable made testable
set -uo pipefail
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
LOC="${LOCATION_BASE_URL:-http://localhost:4004}"
ENG="${ENGINE_BASE_URL:-http://localhost:4005}"
TRK="${TRACKING_BASE_URL:-http://localhost:4006}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.mon-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

echo "=============================================="
echo " HungerHeal Phase 10 - the monitoring view"
echo "=============================================="

echo
echo "1. An admin account exists only to VIEW"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"ADMIN\",\"name\":\"p10admin\",\"email\":\"p10adm_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\"}"
ADMIN_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
[ -n "$ADMIN_TOKEN" ] && ok "admin registered" || bad "admin signup failed: $(body)"

# ADMIN is not a third kind of user with extra powers - it is a viewing
# permission. An admin cannot donate or collect.
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -X POST "$DON/donations" \
  -d '{"title":"admin should not donate","category":"BAKERY","quantityAmount":1,"quantityUnit":"KG","pickupAddress":"somewhere in the city","bestBefore":"2030-01-01T00:00:00Z"}')
[ "$code" = "403" ] && ok "an admin cannot create donations (403)" || bad "expected 403, got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -X POST "$LOC/agents/location" -d '{"lat":12.97,"lng":77.6}')
[ "$code" = "403" ] && ok "an admin cannot report an agent location (403)" || bad "expected 403, got $code"

echo
echo "2. Produce a real assignment to inspect"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"p10near\",\"email\":\"p10n_${STAMP}@example.com\",\"phone\":\"+91 9000000001\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
A1=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
A1_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $A1" \
  -X POST "$LOC/agents/location" -d '{"lat":12.9760,"lng":77.6070}'

# A second agent without an insulated box, so the compatibility term actually
# differs between the two and the breakdown has something to show.
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"p10bare\",\"email\":\"p10b_${STAMP}@example.com\",\"phone\":\"+91 9000000002\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"BICYCLE\",\"hasInsulatedTransport\":false,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
A2=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
A2_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $A2" \
  -X POST "$LOC/agents/location" -d '{"lat":12.9762,"lng":77.6072}'

curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"p10donor\",\"email\":\"p10d_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Monitoring probe biryani\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":30,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":12.9757,\"lng\":77.6068,\"bestBefore\":\"$BB\"}"
DID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$DID" ] && ok "donation created: $DID" || bad "create failed"
sleep 8

echo
echo "3. THE SCORE BREAKDOWN - why this agent"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$TRK/monitoring/donations/$DID")
[ "$code" = "200" ] && ok "GET /monitoring/donations/:id" || bad "detail got $code: $(body)"

OFFERS=$(jq_body "len(d['scoring']['offers'])")
[ "$OFFERS" -ge 2 ] 2>/dev/null && ok "$OFFERS scored candidates recorded" || bad "only $OFFERS offers recorded"

# All four weighted terms, exactly as assignment-engine computed them.
for term in weightedDistance weightedCategory weightedLoad weightedRating; do
  V=$(jq_body "d['scoring']['offers'][0]['breakdown'].get('$term')")
  if [ -n "$V" ] && [ "$V" != "None" ]; then
    ok "$term recorded ($V)"
  else
    bad "$term missing from the breakdown"
  fi
done

# The explanation has to add up, or it is a fiction.
ADDS=$(jq_body "abs(d['scoring']['offers'][0]['score'] - sum(d['scoring']['offers'][0]['breakdown'][k] for k in ['weightedDistance','weightedCategory','weightedLoad','weightedRating'])) < 1e-4")
[ "$ADDS" = "True" ] && ok "the weighted terms sum exactly to the total score" || bad "the breakdown does not add up"

# The insulated agent should out-score the bare one on category fit.
INSULATED_CAT=$(jq_body "[o['breakdown']['categoryScore'] for o in d['scoring']['offers'] if o['agentId']=='$A1_ID'][0]")
BARE_CAT=$(jq_body "[o['breakdown']['categoryScore'] for o in d['scoring']['offers'] if o['agentId']=='$A2_ID'][0]")
if python -c "import sys; sys.exit(0 if float('$INSULATED_CAT') > float('$BARE_CAT') else 1)" 2>/dev/null; then
  ok "the view shows WHY: insulated $INSULATED_CAT vs bare $BARE_CAT on category fit"
else
  bad "category scores did not differentiate: $INSULATED_CAT vs $BARE_CAT"
fi

MAXSCORE=$(jq_body "d['scoring']['weights']['maxPossibleScore']")
# "0.81 out of what?" is answerable rather than left to be puzzled over.
[ "$MAXSCORE" = "0.95" ] && ok "the scale is stated (max possible 0.95)" || bad "maxPossibleScore was $MAXSCORE"

RADIUS=$(jq_body "d['donation']['searchRadiusKm']")
FOUND=$(jq_body "d['donation']['candidatesFound']")
ELIGIBLE=$(jq_body "d['donation']['candidatesEligible']")
[ -n "$RADIUS" ] && [ "$RADIUS" != "None" ] && ok "the search is recorded: ${RADIUS}km, $FOUND found, $ELIGIBLE eligible" || bad "no search detail"

TRACE=$(jq_body "d['donation']['traceId']")
# The id that follows this donation through every service.
[ -n "$TRACE" ] && [ "$TRACE" != "None" ] && ok "the traceId is exposed for log lookup" || bad "no traceId"

TIMELINE=$(jq_body "len(d['timeline'])")
[ "$TIMELINE" -ge 2 ] 2>/dev/null && ok "the full timeline is included ($TIMELINE entries)" || bad "timeline had $TIMELINE entries"

echo
echo "4. THE VIEW IS READ-ONLY"
# The plan's central non-negotiable, made testable. If any of these ever
# returns anything but 404/405, a human has been given back the ability to
# override the algorithm.
for verb in POST PUT PATCH DELETE; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$verb" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$TRK/monitoring/donations/$DID" -d '{"assignedAgentId":"someone-else"}')
  if [ "$code" = "404" ] || [ "$code" = "405" ]; then
    ok "$verb on a donation is not a route ($code)"
  else
    bad "$verb returned $code - a write path exists where none should"
  fi
done

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$TRK/monitoring/donations/$DID/assign" -d '{"agentId":"someone-else"}')
[ "$code" = "404" ] && ok "there is no assign endpoint at all (404)" || bad "an assign route answered with $code"

echo
echo "5. Access control"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DONOR" "$TRK/monitoring/donations")
[ "$code" = "403" ] && ok "a donor cannot open the monitoring view (403)" || bad "expected 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $A1" "$TRK/monitoring/donations")
[ "$code" = "403" ] && ok "an agent cannot either (403)" || bad "expected 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$TRK/monitoring/donations")
[ "$code" = "401" ] && ok "anonymous access rejected (401)" || bad "expected 401, got $code"

echo
echo "6. System-wide statistics"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" "$TRK/monitoring/stats")
[ "$code" = "200" ] && ok "GET /monitoring/stats" || bad "stats got $code"
TOTAL=$(jq_body "d['total']")
[ "$TOTAL" -ge 1 ] 2>/dev/null && ok "$TOTAL donations tracked system-wide" || bad "total was $TOTAL"
HASMATCHING=$(jq_body "'matching' in d")
[ "$HASMATCHING" = "True" ] && ok "matching performance is reported" || bad "no matching stats"

echo
echo "7. The list, and the filter that matters most"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$TRK/monitoring/donations?limit=25")
[ "$code" = "200" ] && ok "GET /monitoring/donations" || bad "list got $code"
SEESALL=$(jq_body "any(x['donationId']=='$DID' for x in d['donations'])")
# System-wide, unlike /tracking which is scoped to the caller.
[ "$SEESALL" = "True" ] && ok "the admin sees donations from every donor" || bad "the probe donation was not listed"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$TRK/monitoring/donations?unmatched=true")
[ "$code" = "200" ] && ok "the unmatched filter works - what is NOT working" || bad "unmatched filter got $code"

echo
echo "Cleaning up..."
for id in "$A1_ID" "$A2_ID"; do
  [ -n "$id" ] || continue
  rcli ZREM agents:live "$id" >/dev/null
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done
rcli DEL "donation:$DID:offer" "donation:$DID:claimed" "donation:$DID:declined" >/dev/null
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

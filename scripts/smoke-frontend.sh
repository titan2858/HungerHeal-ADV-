#!/usr/bin/env bash
# Phase 8 acceptance test: the agent flow AS THE BROWSER MAKES IT.
#
# Every request here goes through the Vite dev server on :5173, using the exact
# paths the React app calls. That is the point: the services were already proven
# in Phases 1-7, and what is untested is the frontend's WIRING - the proxy
# routes, the path rewrites, and the request shapes the client sends.
#
# A proxy typo produces a 404 that no backend test can catch.
set -uo pipefail
export MSYS_NO_PATHCONV=1

WEB="${WEB_BASE_URL:-http://localhost:5173}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.web-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

PLAT=12.9757
PLNG=77.6068
AGENT_IDS=()

echo "=============================================="
echo " HungerHeal Phase 8 - the agent UI's wiring"
echo " through the dev server at $WEB"
echo "=============================================="

echo
echo "1. The app is being served"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$WEB/")
[ "$code" = "200" ] && ok "the page loads" || bad "page got $code (is `npm run dev` running?)"

echo
echo "2. Every proxy route reaches its service"
# A typo in any of these is a 404 the backend suites cannot see.
#
# /api/auth and /api/donations rewrite to /auth and /donations, so /health is
# not reachable under them. What proves the proxy works is that the SERVICE
# answers at all: a 401 is the service rejecting an anonymous request, while a
# 404 would be Vite failing to forward it anywhere.
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$WEB/api/auth/login"   -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrongpass1"}')
[ "$code" = "401" ] && ok "/api/auth -> auth-service (401 from the service)" || bad "/api/auth got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' "$WEB/api/donations")
[ "$code" = "401" ] && ok "/api/donations -> donation-service (401 from the service)" || bad "/api/donations got $code"

for route in "geo/health:4003" "location/health:4004" "engine/health:4005"; do
  path="${route%%:*}"; port="${route##*:}"
  code=$(curl -s -o "$BODY" -w '%{http_code}' "$WEB/api/$path")
  if [ "$code" = "200" ]; then
    ok "/api/$path -> :$port"
  else
    bad "/api/$path got $code"
  fi
done

# tracking and notify rewrite onto their resource paths, so an anonymous
# request reaching the service returns 401 rather than Vite's 404.
for path in "tracking" "notify"; do
  code=$(curl -s -o "$BODY" -w '%{http_code}' "$WEB/api/$path")
  [ "$code" = "401" ] && ok "/api/$path reaches its service (401)" || bad "/api/$path got $code"
done

echo
echo "3. Agent signs up through the app's own path"
curl -s -o "$BODY" -X POST "$WEB/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"webagent\",\"email\":\"webagent_${STAMP}@example.com\",\"phone\":\"+91 9000000001\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
AGENT_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
AGENT_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
AGENT_IDS+=("$AGENT_ID")
[ -n "$AGENT_TOKEN" ] && ok "agent registered with capabilities" || bad "signup failed: $(body)"

echo
echo "4. Going on shift - what useAgentLocation does every 20s"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/location/agents/location" -d "{\"lat\":12.9760,\"lng\":77.6070}")
[ "$code" = "200" ] && ok "POST /api/location/agents/location" || bad "location report got $code: $(body)"

TTL=$(jq_body "d['expiresInSeconds']")
# The UI reports every 20s against this window, so six failures in a row are
# survivable rather than one.
[ "$TTL" = "120" ] && ok "the response states the 120s heartbeat window" || bad "expiresInSeconds was $TTL"

[ -n "$(rcli ZSCORE agents:live "$AGENT_ID")" ] && ok "the agent is on the map in Redis" || bad "agent missing from the geo set"

echo
echo "5. The availability toggle"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/location/agents/availability" -d '{"available":false}')
[ "$code" = "200" ] && ok "can stop accepting new requests" || bad "availability got $code"
curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/location/agents/availability" -d '{"available":true}'

echo
echo "6. A donor posts food through the app"
curl -s -o "$BODY" -X POST "$WEB/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"webdonor\",\"email\":\"webdonor_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR_TOKEN" \
  -H "x-trace-id: p8-web-$STAMP" \
  -X POST "$WEB/api/donations" \
  -d "{\"title\":\"Biryani via the web app\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":25,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":$PLAT,\"lng\":$PLNG,\"bestBefore\":\"$BB\"}"
DONATION_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$DONATION_ID" ] && ok "donation created: $DONATION_ID" || bad "create failed: $(body)"

echo "         -> waiting for the pipeline..."
sleep 8

echo
echo "7. The offer reaches the agent's inbox - what useOffers polls"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  "$WEB/api/notify?limit=50")
[ "$code" = "200" ] && ok "GET /api/notify" || bad "notifications got $code: $(body)"

OFFERS=$(jq_body "sum(1 for n in d['notifications'] if n['kind']=='OFFER' and n['donationId']=='$DONATION_ID')")
[ "$OFFERS" = "1" ] && ok "the collection request is in the inbox" || bad "expected 1 OFFER, got $OFFERS"

# useOffers filters on this to drive the countdown, and hides offers whose
# expiresAt has passed.
EXPIRES=$(jq_body "[n['expiresAt'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")
[ "$EXPIRES" != "None" ] && [ -n "$EXPIRES" ] && ok "the offer carries expiresAt, which drives the countdown" || bad "no expiresAt"

RANK=$(jq_body "[n['meta']['rank'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")
# OfferCard shows this so an agent knows WHY they were asked.
[ -n "$RANK" ] && [ "$RANK" != "None" ] && ok "the offer carries the agent's rank (#$RANK)" || bad "no rank in meta"

UNREAD=$(jq_body "d['unreadCount']")
[ "$UNREAD" -ge 1 ] 2>/dev/null && ok "unreadCount drives the badge ($UNREAD)" || bad "unreadCount was $UNREAD"

echo
echo "8. Checking whether an offer is still open"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  "$WEB/api/engine/offers/$DONATION_ID")
[ "$code" = "200" ] && ok "GET /api/engine/offers/:id" || bad "offer lookup got $code"
OPEN=$(jq_body "d['open']")
[ "$OPEN" = "True" ] && ok "the offer reports itself open" || bad "open was $OPEN"

echo
echo "9. Accepting - the Accept button's request"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/engine/offers/$DONATION_ID/accept")
[ "$code" = "200" ] && ok "POST /api/engine/offers/:id/accept" || bad "accept got $code: $(body)"

ADDRESS=$(jq_body "d['donation']['address']")
# The card shows this on success: the agent needs to know where to go.
[ -n "$ADDRESS" ] && [ "$ADDRESS" != "None" ] && ok "the response returns the pickup address" || bad "no address returned"

echo
echo "10. Accepting twice returns 409, which the card renders as 'taken'"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/engine/offers/$DONATION_ID/accept")
# OfferCard branches on exactly this status. If it were a 500 the agent would
# see "something went wrong" instead of "someone was quicker".
[ "$code" = "409" ] && ok "a second accept is 409 ALREADY_CLAIMED" || bad "expected 409, got $code"

echo
echo "11. The 'to collect' list - what AgentDashboard loads"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  "$WEB/api/tracking?status=ACCEPTED")
[ "$code" = "200" ] && ok "GET /api/tracking?status=ACCEPTED" || bad "tracking list got $code: $(body)"
JOBS=$(jq_body "sum(1 for t in d['tracking'] if t['donationId']=='$DONATION_ID')")
[ "$JOBS" = "1" ] && ok "the accepted donation appears in the agent's list" || bad "expected 1 job, got $JOBS"

echo
echo "12. Marking collected"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/tracking/$DONATION_ID/collected")
[ "$code" = "202" ] && ok "POST /api/tracking/:id/collected -> 202" || bad "collect got $code: $(body)"

sleep 6
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/$DONATION_ID" >/dev/null
STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "COLLECTED" ] && ok "the donation is COLLECTED" || bad "status was '$STATUS'"

echo
echo "13. The donor's view reads tracking-service, not the stale status"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" \
  "$WEB/api/tracking?limit=20")
[ "$code" = "200" ] && ok "GET /api/tracking (donor list)" || bad "donor tracking got $code"

MESSAGE=$(jq_body "[t['message'] for t in d['tracking'] if t['donationId']=='$DONATION_ID'][0]")
# The donor sees a sentence, not an enum.
[ -n "$MESSAGE" ] && [ "$MESSAGE" != "None" ] && ok "donor sees: \"$MESSAGE\"" || bad "no donor message"

# donation-service still reports the creation-time status, which is exactly why
# the UI reads tracking-service instead.
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/donations" >/dev/null
STALE=$(jq_body "[x['status'] for x in d['donations'] if x['id']=='$DONATION_ID'][0]")
if [ "$STALE" = "PENDING_ASSIGNMENT" ]; then
  ok "donation-service still says PENDING_ASSIGNMENT - the known stale field the UI avoids"
else
  ok "donation-service reports $STALE"
fi

echo
echo "14. Ending the shift removes the agent immediately"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/location/agents/offline")
[ "$code" = "200" ] && ok "POST /api/location/agents/offline" || bad "offline got $code"
# Not after the 120s heartbeat lapses: otherwise they keep receiving offers for
# two minutes after finishing, and each one times out and delays a donation.
[ -z "$(rcli ZSCORE agents:live "$AGENT_ID")" ] && ok "removed from the map at once" || bad "still on the map"

echo
echo "Cleaning up..."
for id in "${AGENT_IDS[@]}"; do
  [ -n "$id" ] || continue
  rcli ZREM agents:live "$id" >/dev/null
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done
rcli DEL "donation:$DONATION_ID:offer" "donation:$DONATION_ID:claimed" "donation:$DONATION_ID:declined" >/dev/null
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

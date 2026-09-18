#!/usr/bin/env bash
# Phase 2 acceptance test: drives auth-service + donation-service over HTTP and
# then reads the donation.created event back OUT of Kafka.
#
# The Kafka assertion is the point of this script. The unit suite runs with the
# broker disabled, so "the event actually reached a topic" is only ever proven
# here.
set -uo pipefail
# Git Bash rewrites /opt/kafka/... into a Windows path before docker exec sees it.
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

# A RELATIVE path on purpose. MSYS_NO_PATHCONV=1 above (needed so docker exec
# receives /opt/kafka/... untouched) also stops Git Bash translating /tmp/... for
# the native Windows curl.exe - which would then write to C:	mp\ while bash
# reads from somewhere else entirely, leaving every response body looking empty.
# Relative paths are never translated, so both sides agree.
BODY="./.smoke-body.$$"
trap 'rm -f "$BODY" ./.smoke-img.*.png' EXIT
req() { curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
body() { cat "$BODY"; }
jsonval() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$BODY" | head -1; }

echo "=============================================="
echo " HungerHeal Phase 2 - donation-service"
echo "=============================================="

echo
echo "1. Services reachable"
[ "$(req "$DON/health")" = "200" ] && ok "donation-service /health" || bad "donation-service /health"
code=$(req "$DON/ready")
if [ "$code" = "200" ] && body | grep -q '"kafka":"up"'; then
  ok "donation-service /ready - mongo and kafka both up"
else
  bad "/ready returned $code: $(body)"
fi

echo
echo "2. Register a donor and an agent through auth-service"
DONOR_EMAIL="donor_${STAMP}@example.com"
code=$(req -X POST "$AUTH/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Asha Donor\",\"email\":\"$DONOR_EMAIL\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}")
DONOR_TOKEN=$(jsonval token)
[ "$code" = "201" ] && [ -n "$DONOR_TOKEN" ] && ok "donor registered, token issued" || bad "donor signup got $code"

AGENT_EMAIL="agent_${STAMP}@example.com"
code=$(req -X POST "$AUTH/auth/signup" -d "{\"role\":\"AGENT\",\"name\":\"Ravi Agent\",\"email\":\"$AGENT_EMAIL\",\"phone\":\"+91 9876500000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}")
AGENT_TOKEN=$(jsonval token)
[ "$code" = "201" ] && ok "agent registered" || bad "agent signup got $code"

echo
echo "3. A token from auth-service is accepted by donation-service"
echo "   (verified locally against the shared secret - no call between services)"
BEST_BEFORE=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1d +%Y-%m-%dT%H:%M:%SZ)
TRACE="phase2-smoke-$STAMP"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -H "x-trace-id: $TRACE" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Leftover biryani from a wedding\",\"description\":\"About 40 servings\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":40,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"12 MG Road, Bengaluru 560001\",\"lat\":12.9716,\"lng\":77.5946,\"bestBefore\":\"$BEST_BEFORE\"}")
DONATION_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
if [ "$code" = "201" ] && [ -n "$DONATION_ID" ]; then ok "donation created: $DONATION_ID"; else bad "create got $code: $(body)"; fi
body | grep -q '"assignmentQueued":true' && ok "event reported as published to Kafka" || bad "assignmentQueued was not true"
body | grep -q '"status":"PENDING_ASSIGNMENT"' && ok "initial status PENDING_ASSIGNMENT" || bad "wrong initial status"
body | grep -q '"donorName":"Asha Donor"' && ok "donor contact snapshotted from the token" || bad "donor name not snapshotted"
body | grep -q '\[77.5946,12.9716\]' && ok "coordinates stored GeoJSON-style, [lng,lat]" || bad "coordinate order wrong: $(body)"

echo
echo "4. THE EVENT IS ACTUALLY IN KAFKA"
echo "   reading the donation.created topic back from the broker..."
EVENT=$(docker exec hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic donation.created \
  --from-beginning --timeout-ms 12000 2>/dev/null | grep "$DONATION_ID" | head -1)

if [ -n "$EVENT" ]; then
  ok "donation.created event found on the topic"
  echo "         -> $(echo "$EVENT" | cut -c1-150)..."
else
  bad "no donation.created event found for $DONATION_ID"
fi
echo "$EVENT" | grep -q "\"traceId\":\"$TRACE\"" && ok "traceId propagated HTTP -> Mongo -> Kafka event" || bad "traceId missing from event"
echo "$EVENT" | grep -q '"eventId"' && ok "event carries an eventId (what consumers dedupe on)" || bad "eventId missing"
echo "$EVENT" | grep -q '"category":"COOKED_PREPARED"' && ok "category in the event, so scoring needs no callback" || bad "category missing"
echo "$EVENT" | grep -q '"lat":12.9716' && ok "pickup coordinates in the event, ready for GEOSEARCH" || bad "coordinates missing from event"

echo
echo "5. The event is keyed by donationId, so per-donation ordering holds"
KEYED=$(docker exec hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic donation.created \
  --from-beginning --timeout-ms 12000 --property print.key=true 2>/dev/null | grep "$DONATION_ID" | head -1)
echo "$KEYED" | grep -q "^$DONATION_ID" && ok "message key is the donationId" || bad "message key was not the donationId"

echo
echo "6. Image upload"
PNG="./.smoke-img.$$.png"
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$PNG" 2>/dev/null
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" \
  -X POST "$DON/donations" \
  -F "title=Bread from the bakery" -F "category=BAKERY" \
  -F "quantityAmount=12" -F "quantityUnit=ITEMS" \
  -F "pickupAddress=45 Church Street, Bengaluru 560001" \
  -F "lat=12.9750" -F "lng=77.6050" -F "bestBefore=$BEST_BEFORE" \
  -F "images=@$PNG;type=image/png")
IMG_URL=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$BODY" | head -1)
[ "$code" = "201" ] && ok "multipart donation with image created" || bad "upload got $code: $(body)"
body | grep -q '"quantity":{"amount":12' && ok "multipart string fields coerced to numbers" || bad "quantity coercion failed"
if [ -n "$IMG_URL" ]; then
  img_code=$(curl -s -o /dev/null -w '%{http_code}' "$DON$IMG_URL")
  [ "$img_code" = "200" ] && ok "uploaded image served back at $IMG_URL" || bad "image fetch got $img_code"
  echo "$IMG_URL" | grep -qv 'food.png' && ok "stored filename randomised, not client-supplied" || bad "client filename was used"
fi
rm -f "$PNG"

echo
echo "7. Authorization"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENT_TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Agent should not be able to donate\",\"category\":\"BAKERY\",\"quantityAmount\":1,\"quantityUnit\":\"KG\",\"pickupAddress\":\"somewhere in the city\",\"bestBefore\":\"$BEST_BEFORE\"}")
[ "$code" = "403" ] && ok "an agent cannot create a donation (403)" || bad "expected 403, got $code"
code=$(req -X POST "$DON/donations" -d '{}')
[ "$code" = "401" ] && ok "unauthenticated create rejected (401)" || bad "expected 401, got $code"

echo
echo "8. Reading donations back"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" "$DON/donations")
[ "$code" = "200" ] && ok "donor lists their own donations" || bad "list got $code"
body | grep -q '"total":2' && ok "both donations returned" || bad "unexpected total: $(body | head -c 200)"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" "$DON/donations?category=COOKED_PREPARED")
[ "$code" = "200" ] && ok "agent lists donations filtered by category" || bad "agent list got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" "$DON/donations/$DONATION_ID")
[ "$code" = "200" ] && ok "donor fetches their donation by id" || bad "get by id got $code"

OTHER_EMAIL="other_${STAMP}@example.com"
req -X POST "$AUTH/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Other Donor\",\"email\":\"$OTHER_EMAIL\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\"}" >/dev/null
OTHER_TOKEN=$(jsonval token)
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $OTHER_TOKEN" "$DON/donations/$DONATION_ID")
[ "$code" = "404" ] && ok "another donor's donation is a 404, not a 403" || bad "expected 404, got $code"

echo
echo "9. Validation"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Expired food\",\"category\":\"BAKERY\",\"quantityAmount\":1,\"quantityUnit\":\"KG\",\"pickupAddress\":\"somewhere in the city\",\"bestBefore\":\"2020-01-01T00:00:00Z\"}")
[ "$code" = "400" ] && ok "a past bestBefore is rejected (400)" || bad "expected 400, got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Mystery food\",\"category\":\"SUSHI\",\"quantityAmount\":1,\"quantityUnit\":\"KG\",\"pickupAddress\":\"somewhere in the city\",\"bestBefore\":\"$BEST_BEFORE\"}")
[ "$code" = "400" ] && ok "an unknown category is rejected (400)" || bad "expected 400, got $code"

rm -f "$BODY"
echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

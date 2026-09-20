#!/usr/bin/env bash
# Phase 3 acceptance test: geocoding-service against the running stack, and
# donation-service's use of it.
#
# The cache assertions are the point: the second identical lookup must come back
# cached, and a differently-spelled version of the same address must hit the
# SAME entry. That is what turns a rate-limited, paid API into one call per
# distinct address instead of one per request.
set -uo pipefail

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
GEO="${GEOCODING_BASE_URL:-http://localhost:4003}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

# Relative path: see the note in smoke-donation.sh about MSYS path conversion.
BODY="./.geo-body.$$"
trap 'rm -f "$BODY"' EXIT
req() { curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
body() { cat "$BODY"; }
authed() { curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$@"; }

echo "=============================================="
echo " HungerHeal Phase 3 - geocoding-service"
echo "=============================================="

echo
echo "1. Service reachable"
code=$(req "$GEO/health")
[ "$code" = "200" ] && ok "GET /health ($(body | sed -n 's/.*"provider":"\([^"]*\)".*/provider: \1/p'))" || bad "health got $code"
code=$(req "$GEO/ready")
if [ "$code" = "200" ] && body | grep -q '"redis":"up"'; then ok "GET /ready - redis connected"; else bad "/ready: $(body)"; fi

echo
echo "2. Authentication"
code=$(req "$GEO/geocode?address=12%20MG%20Road,%20Bengaluru")
# Every uncached lookup spends real provider quota, so this must not be open.
[ "$code" = "401" ] && ok "unauthenticated lookup rejected (401)" || bad "expected 401, got $code"

EMAIL="geo_${STAMP}@example.com"
code=$(req -X POST "$AUTH/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Geo Tester\",\"email\":\"$EMAIL\",\"phone\":\"+91 9000000002\",\"password\":\"goodpass1\"}")
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
[ "$code" = "201" ] && [ -n "$TOKEN" ] && ok "donor registered for the test" || bad "signup got $code"

# A unique address per run, so cache assertions are not satisfied by a previous run.
ADDR="Plot%20${STAMP}%20Residency%20Road,%20Bengaluru"
ADDR_MESSY="%20%20plot%20${STAMP}%20%20%20RESIDENCY%20road,,%20bengaluru%20"

echo
echo "3. Forward geocoding"
code=$(authed "$GEO/geocode?address=$ADDR")
if [ "$code" = "200" ]; then
  ok "address resolved to coordinates"
  echo "         -> $(body | cut -c1-140)"
else
  bad "geocode got $code: $(body)"
fi
body | grep -q '"cached":false' && ok "first lookup was a cache MISS (correct)" || bad "first lookup should be a miss"
LAT1=$(body | sed -n 's/.*"lat":\([0-9.-]*\).*/\1/p')

echo
echo "4. THE CACHE"
code=$(authed "$GEO/geocode?address=$ADDR")
body | grep -q '"cached":true' && ok "second identical lookup served from Redis" || bad "second lookup was not cached: $(body)"
LAT2=$(body | sed -n 's/.*"lat":\([0-9.-]*\).*/\1/p')
[ "$LAT1" = "$LAT2" ] && ok "cached answer matches the original (a wrong cache is worse than none)" || bad "cached value differs: $LAT1 vs $LAT2"

code=$(authed "$GEO/geocode?address=$ADDR_MESSY")
# Different case, extra spaces, doubled commas - the same place, so it must not
# cost a second provider call.
body | grep -q '"cached":true' && ok "differently-spelled same address hit the SAME cache entry" || bad "normalization failed: $(body)"

echo
echo "5. Not-found handling"
code=$(authed "$GEO/geocode?address=nowhere%20asdfghjklqwertyuiop%20zxcvbnm%20qqzzxx%20${STAMP}")
[ "$code" = "404" ] && ok "unresolvable address returns 404" || bad "expected 404, got $code"
code=$(authed "$GEO/geocode?address=nowhere%20asdfghjklqwertyuiop%20zxcvbnm%20qqzzxx%20${STAMP}")
# Negative caching: without it, a client retrying a typo drains the daily quota.
[ "$code" = "404" ] && ok "repeat of the same failure still 404 (negatively cached)" || bad "expected 404, got $code"

echo
echo "6. Reverse geocoding - what the map pin drag calls"
code=$(authed "$GEO/reverse?lat=12.9757&lng=77.6068")
[ "$code" = "200" ] && ok "coordinates resolved to an address" || bad "reverse got $code: $(body)"
code=$(authed "$GEO/reverse?lat=12.9757&lng=77.6068")
body | grep -q '"cached":true' && ok "repeat reverse lookup cached" || bad "reverse not cached"
code=$(authed "$GEO/reverse?lat=12.97570912&lng=77.60680912")
# ~1m away. Rounding to 4dp is what lets a dragged pin hit the cache at all.
body | grep -q '"cached":true' && ok "pin nudged ~1m reused the cached answer" || bad "coordinate rounding failed"

echo
echo "7. Validation"
code=$(authed "$GEO/geocode"); [ "$code" = "400" ] && ok "missing address rejected (400)" || bad "expected 400, got $code"
code=$(authed "$GEO/reverse?lat=91&lng=77"); [ "$code" = "400" ] && ok "latitude out of range rejected (400)" || bad "expected 400, got $code"

echo
echo "8. Cache statistics"
code=$(authed "$GEO/stats")
if [ "$code" = "200" ]; then
  ok "GET /stats"
  echo "         -> $(body | cut -c1-200)"
else
  bad "stats got $code"
fi
body | grep -q '"hitRate"' && ok "hit rate reported - the number that justifies this service" || bad "no hit rate"

echo
echo "9. donation-service uses it: a donation with NO coordinates"
BB=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1d +%Y-%m-%dT%H:%M:%SZ)
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Bread with no coordinates\",\"category\":\"BAKERY\",\"quantityAmount\":10,\"quantityUnit\":\"ITEMS\",\"pickupAddress\":\"Koramangala, Bengaluru\",\"bestBefore\":\"$BB\"}")
[ "$code" = "201" ] && ok "donation created without client-supplied coordinates" || bad "create got $code: $(body)"
body | grep -q '"derivedFromAddress":true' && ok "donation-service geocoded the address itself" || bad "coordinates were not derived: $(body | cut -c1-200)"
COORDS=$(grep -o '"coordinates":\[[^]]*\]' "$BODY" | head -1 | tr -d '[]' | cut -d: -f2 | tr ',' ' ')
set -- $COORDS
# Bengaluru's bounding box. Asserting a range rather than exact values keeps
# this honest across providers - and would still catch the classic bug of
# storing [lat,lng] instead of [lng,lat], which puts the pickup in Somalia.
if [ -n "${1:-}" ] && awk -v lng="$1" -v lat="$2" 'BEGIN{exit !(lng>77.3 && lng<77.9 && lat>12.7 && lat<13.3)}'; then
  ok "coordinates stored [lng,lat] and land in Bengaluru (lng=$1 lat=$2)"
else
  bad "coordinates outside Bengaluru or wrong order: ${COORDS:-none}"
fi
body | grep -q '"assignmentQueued":true' && ok "the donation.created event still published" || bad "event not published"

echo
echo "10. A donation is never lost to a geocoding failure"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -X POST "$DON/donations" \
  -d "{\"title\":\"Food at an unresolvable address\",\"category\":\"BAKERY\",\"quantityAmount\":3,\"quantityUnit\":\"KG\",\"pickupAddress\":\"nowhere asdfghjklqwertyuiop zxcvbnm qqzzxx ${STAMP}\",\"bestBefore\":\"$BB\"}")
# A real offer of food must not be thrown away because an address did not
# resolve - it is stored, flagged, and can be geocoded later.
[ "$code" = "201" ] && ok "donation still created when the address cannot be geocoded" || bad "expected 201, got $code"
body | grep -q 'could not be geocoded' && ok "donor told it cannot be matched yet" || bad "no notice returned"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

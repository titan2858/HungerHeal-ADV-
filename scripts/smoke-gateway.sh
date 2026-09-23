#!/usr/bin/env bash
# Phase 12 acceptance test: the api-gateway and the containerized frontend.
#
# EVERY request here goes to :4000 or :8080. No service port is touched
# directly, which is the point: after this phase the browser knows exactly one
# address, and the seven service ports are an implementation detail.
set -uo pipefail
export MSYS_NO_PATHCONV=1

GW="${GATEWAY_BASE_URL:-http://localhost:4000}"
WEB="${WEB_BASE_URL:-http://localhost:8080}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.gw-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

echo "=============================================="
echo " HungerHeal Phase 12 - gateway + containers"
echo "=============================================="

echo
echo "1. One endpoint answers for the whole system"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$GW/ready")
[ "$code" = "200" ] && ok "GET /ready aggregates every service" || bad "/ready got $code: $(body)"
UP=$(jq_body "sum(1 for v in d['services'].values() if v=='up')")
[ "$UP" = "7" ] && ok "all 7 services reported up in one call" || bad "only $UP services up"

echo
echo "2. The frontend is a container, not a dev server"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$WEB/")
[ "$code" = "200" ] && ok "nginx serves the built app on :8080" || bad "frontend got $code"
body | grep -qi "hungerheal" && ok "the page is the app, not a default nginx page" || bad "unexpected page content"

# Client-side routing: an unknown path must serve index.html, not 404.
code=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/some/client/route")
[ "$code" = "200" ] && ok "unknown paths serve index.html (SPA routing)" || bad "SPA fallback got $code"

echo
echo "3. The browser talks to ONE origin"
# nginx proxies /api to the gateway, so the built app never needs a service
# port or a CORS rule.
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$WEB/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrongpass1"}')
[ "$code" = "401" ] && ok "/api through nginx reaches auth-service (401 from the service)" || bad "got $code"

echo
echo "4. The whole journey, through the gateway only"
curl -s -o "$BODY" -X POST "$GW/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"gwagent\",\"email\":\"gwa_${STAMP}@example.com\",\"phone\":\"+91 9000000001\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
AGENT=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
AGENT_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$AGENT" ] && ok "signup via /api/auth" || bad "signup failed: $(body)"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENT" -X POST "$GW/api/location/agents/location" \
  -d '{"lat":12.9760,"lng":77.6070}')
[ "$code" = "200" ] && ok "location report via /api/location" || bad "location got $code"

curl -s -o "$BODY" -X POST "$GW/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"gwdonor\",\"email\":\"gwd_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR" \
  -H "x-trace-id: p12-gw-$STAMP" \
  -X POST "$GW/api/donations" \
  -d "{\"title\":\"Posted through the gateway\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":20,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":12.9757,\"lng\":77.6068,\"bestBefore\":\"$BB\"}"
DID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$DID" ] && ok "donation created via /api/donations: $DID" || bad "create failed: $(body)"

sleep 8
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT" "$GW/api/notify?limit=20")
[ "$code" = "200" ] && ok "notifications via /api/notify" || bad "notify got $code"
OFFERS=$(jq_body "sum(1 for n in d['notifications'] if n['donationId']=='$DID')")
[ "$OFFERS" -ge 1 ] 2>/dev/null && ok "the offer reached the agent through the gateway" || bad "no offer found"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT" \
  -X POST "$GW/api/engine/offers/$DID/accept")
[ "$code" = "200" ] && ok "accept via /api/engine" || bad "accept got $code: $(body)"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR" "$GW/api/tracking/$DID")
[ "$code" = "200" ] && ok "tracking via /api/tracking" || bad "tracking got $code"
STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "ACCEPTED" ] && ok "status is ACCEPTED - the full chain worked through one port" || bad "status was $STATUS"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR" \
  "$GW/api/geo/geocode?address=Koramangala,%20Bengaluru")
[ "$code" = "200" ] && ok "geocoding via /api/geo" || bad "geo got $code"

echo
echo "5. The gateway verifies the token at the EDGE"
# Rejected here, before the request ever reaches a service.
code=$(curl -s -o "$BODY" -w '%{http_code}' "$GW/api/donations")
[ "$code" = "401" ] && ok "no token is rejected at the gateway (401)" || bad "expected 401, got $code"
ERRCODE=$(jq_body "d['error']['code']")
[ "$ERRCODE" = "UNAUTHORIZED" ] && ok "and in the same error shape every service uses" || bad "error code was $ERRCODE"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer not.a.real.token" "$GW/api/donations")
[ "$code" = "401" ] && ok "a malformed token is rejected (401)" || bad "expected 401, got $code"

TAMPERED="${AGENT%????}beef"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TAMPERED" "$GW/api/donations")
[ "$code" = "401" ] && ok "a tampered token is rejected (401)" || bad "expected 401, got $code"

# Login and signup cannot require a token, by definition.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"x@example.com","password":"wrongpass1"}')
[ "$code" = "401" ] && ok "auth routes are forwarded without a token (reached the service)" || bad "auth route got $code"

echo
echo "6. The traceId survives the extra hop"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR" "$GW/api/tracking/$DID" >/dev/null
TRACE=$(jq_body "d['tracking']['traceId']")
# HTTP -> gateway -> donation-service -> Kafka -> engine -> tracking-service.
[ "$TRACE" = "p12-gw-$STAMP" ] && ok "the donor's traceId reached tracking through the gateway" || bad "trace was '$TRACE'"

echo
echo "7. Routing precedence"
# /api/monitoring and /api/tracking both live on tracking-service, and Express
# matches prefixes in order. Registered the wrong way round, /api/tracking
# would swallow monitoring requests.
curl -s -o "$BODY" -X POST "$GW/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"ADMIN\",\"name\":\"gwadmin\",\"email\":\"gwm_${STAMP}@example.com\",\"phone\":\"+91 9000000009\",\"password\":\"goodpass1\"}"
ADMIN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$GW/api/monitoring/stats")
[ "$code" = "200" ] && ok "/api/monitoring is not swallowed by /api/tracking" || bad "monitoring got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DONOR" "$GW/api/monitoring/stats")
[ "$code" = "403" ] && ok "role checks still happen at the service (403)" || bad "expected 403, got $code"

echo
echo "8. An unknown route is a clean 404"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$GW/api/nonexistent")
[ "$code" = "404" ] && ok "unmapped paths return 404 with a traceId" || bad "expected 404, got $code"
jq_body "d['error']['traceId']" | grep -q . && ok "even the 404 carries a traceId" || bad "no traceId on the 404"

echo
echo "9. Rate limiting, at the edge rather than per service"
# Only failed attempts count, so a legitimate user is never locked out by
# logging in successfully.
LIMITED=0
for i in $(seq 1 28); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"bruteforce_${STAMP}@example.com\",\"password\":\"wrongpass$i\"}")
  [ "$code" = "429" ] && { LIMITED=1; break; }
done
[ "$LIMITED" = "1" ] && ok "repeated failed logins are rate limited (429)" || bad "no rate limit after 28 attempts"

# A different route must not be affected by the auth limiter.
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DONOR" "$GW/api/tracking")
[ "$code" = "200" ] && ok "other routes are unaffected by the auth limiter" || bad "tracking got $code"

echo
echo "10. Optional services degrade rather than break the gateway"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$GW/api/analytics/daily")
# analytics-service is behind a profile. Whether it is running or not, the
# gateway answers - 200 if up, 502 if not - rather than failing to start.
if [ "$code" = "200" ]; then
  ok "analytics is running and reachable through the gateway"
elif [ "$code" = "502" ]; then
  ok "analytics is not deployed; the gateway returns 502 rather than crashing"
else
  bad "analytics route got $code"
fi

echo
echo "Cleaning up..."
rcli ZREM agents:live "$AGENT_ID" >/dev/null
rcli DEL "agent:$AGENT_ID:caps" "agent:$AGENT_ID:alive" "agent:$AGENT_ID:load" >/dev/null
rcli DEL "donation:$DID:offer" "donation:$DID:claimed" "donation:$DID:declined" >/dev/null
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

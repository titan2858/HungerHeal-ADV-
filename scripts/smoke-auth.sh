#!/usr/bin/env bash
# Phase 1 acceptance test: drives the RUNNING auth-service container over HTTP.
# The unit suite (npm test) proves the logic; this proves the container, its
# config, and its Mongo connection are wired up correctly.
set -uo pipefail
BASE="${AUTH_BASE_URL:-http://localhost:4001}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

# Prints the HTTP status of a request, with the body saved to $BODY_FILE.
BODY_FILE=$(mktemp)
req() { curl -s -o "$BODY_FILE" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
body() { cat "$BODY_FILE"; }

echo "=============================================="
echo " HungerHeal Phase 1 — auth-service smoke test"
echo " target: $BASE"
echo "=============================================="

echo
echo "1. Service reachable"
[ "$(req "$BASE/health")" = "200" ] && ok "GET /health" || bad "GET /health"
[ "$(req "$BASE/ready")"  = "200" ] && ok "GET /ready (mongo reachable)" || bad "GET /ready"

echo
echo "2. Donor signup"
DONOR_EMAIL="donor_${STAMP}@example.com"
code=$(req -X POST "$BASE/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Asha Donor\",\"email\":\"$DONOR_EMAIL\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}")
if [ "$code" = "201" ]; then ok "donor created (201)"; else bad "donor signup got $code: $(body)"; fi
if ! body | grep -q 'passwordHash'; then ok "response does not leak passwordHash"; else bad "passwordHash leaked"; fi

echo
echo "3. Agent signup with declared capabilities"
AGENT_EMAIL="agent_${STAMP}@example.com"
code=$(req -X POST "$BASE/auth/signup" -d "{\"role\":\"AGENT\",\"name\":\"Ravi Agent\",\"email\":\"$AGENT_EMAIL\",\"phone\":\"+91 9876500000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\",\"BAKERY\"]}}")
if [ "$code" = "201" ]; then ok "agent created (201)"; else bad "agent signup got $code: $(body)"; fi
if body | grep -q '"rating":3.5'; then ok "new agent seeded with neutral 3.5 rating"; else bad "agent rating default"; fi
if body | grep -q 'COOKED_PREPARED'; then ok "capabilities persisted for Phase 5 scoring"; else bad "capabilities persisted"; fi

echo
echo "4. Rejections"
code=$(req -X POST "$BASE/auth/signup" -d "{\"role\":\"AGENT\",\"name\":\"No Caps\",\"email\":\"nocaps_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\"}")
[ "$code" = "400" ] && ok "agent without capabilities rejected (400)" || bad "expected 400, got $code"
code=$(req -X POST "$BASE/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Weak\",\"email\":\"weak_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"short\"}")
[ "$code" = "400" ] && ok "weak password rejected (400)" || bad "expected 400, got $code"
code=$(req -X POST "$BASE/auth/signup" -d "{\"role\":\"DONOR\",\"name\":\"Dup\",\"email\":\"$DONOR_EMAIL\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\"}")
[ "$code" = "409" ] && ok "duplicate email rejected (409)" || bad "expected 409, got $code"

echo
echo "5. Login"
code=$(req -X POST "$BASE/auth/login" -d "{\"email\":\"$AGENT_EMAIL\",\"password\":\"goodpass1\"}")
TOKEN=$(body | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ "$code" = "200" ] && [ -n "$TOKEN" ]; then ok "login returned a JWT"; else bad "login got $code: $(body)"; fi
code=$(req -X POST "$BASE/auth/login" -d "{\"email\":\"$AGENT_EMAIL\",\"password\":\"wrongpass1\"}")
[ "$code" = "401" ] && ok "wrong password rejected (401)" || bad "expected 401, got $code"
code=$(req -X POST "$BASE/auth/login" -d "{\"email\":\"ghost_${STAMP}@example.com\",\"password\":\"whatever1\"}")
if [ "$code" = "401" ] && body | grep -q 'invalid email or password'; then
  ok "unknown email gives the same 401 (no account enumeration)"
else bad "unknown email response differed"; fi

echo
echo "6. Authenticated request with the issued token"
code=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/auth/me")
if [ "$code" = "200" ] && body | grep -q "$AGENT_EMAIL"; then ok "GET /auth/me returned the caller"; else bad "GET /auth/me got $code: $(body)"; fi
code=$(req "$BASE/auth/me")
[ "$code" = "401" ] && ok "GET /auth/me without a token rejected (401)" || bad "expected 401, got $code"
code=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN%????}beef" "$BASE/auth/me")
[ "$code" = "401" ] && ok "tampered token rejected (401)" || bad "expected 401, got $code"

echo
echo "7. Trace propagation"
tid=$(curl -s -D - -o /dev/null -H 'x-trace-id: smoke-trace-123' "$BASE/health" | grep -i '^x-trace-id' | tr -d '\r' | awk '{print $2}')
[ "$tid" = "smoke-trace-123" ] && ok "incoming x-trace-id echoed back for cross-service tracing" || bad "trace id was $tid"

rm -f "$BODY_FILE"
echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

#!/usr/bin/env bash
# Phase 9 acceptance test: the donor dashboard's data.
#
# The donor UI is mostly presentation, so what is worth testing is the DATA it
# renders: that a tracking row carries enough to describe the donation without
# a second call, and that the impact figures count what was actually collected
# rather than what was merely offered.
#
# Everything goes through the Vite dev server, using the paths the app calls.
set -uo pipefail
export MSYS_NO_PATHCONV=1

WEB="${WEB_BASE_URL:-http://localhost:5173}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.donor-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)

post_donation() {
  local title="$1" amount="$2" unit="$3"
  curl -s -o "$BODY" -H 'Content-Type: application/json' -H "Authorization: Bearer $DONOR_TOKEN" \
    -X POST "$WEB/api/donations" \
    -d "{\"title\":\"$title\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":$amount,\"quantityUnit\":\"$unit\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":12.9757,\"lng\":77.6068,\"bestBefore\":\"$BB\"}"
  sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1
}

echo "=============================================="
echo " HungerHeal Phase 9 - the donor dashboard"
echo "=============================================="

echo
echo "1. Setting up"
curl -s -o "$BODY" -X POST "$WEB/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"AGENT\",\"name\":\"p9agent\",\"email\":\"p9a_${STAMP}@example.com\",\"phone\":\"+91 9000000001\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
AGENT_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
AGENT_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)

curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/location/agents/location" -d '{"lat":12.9760,"lng":77.6070}'

curl -s -o "$BODY" -X POST "$WEB/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"p9donor\",\"email\":\"p9d_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
[ -n "$DONOR_TOKEN" ] && [ -n "$AGENT_TOKEN" ] && ok "donor and agent registered" || bad "setup failed"

echo
echo "2. A donation carries its own description into tracking"
D1=$(post_donation "Wedding biryani" 40 SERVINGS)
[ -n "$D1" ] && ok "donation created: $D1" || bad "create failed: $(body)"
sleep 8

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/$D1" >/dev/null
TITLE=$(jq_body "d['tracking'].get('title')")
# Without these on the tracking row, every card in the dashboard would need a
# second call back into donation-service.
[ "$TITLE" = "Wedding biryani" ] && ok "title reached tracking-service" || bad "title was '$TITLE'"

AMOUNT=$(jq_body "d['tracking'].get('quantity',{}).get('amount')")
UNIT=$(jq_body "d['tracking'].get('quantity',{}).get('unit')")
[ "$AMOUNT" = "40" ] && [ "$UNIT" = "SERVINGS" ] && ok "quantity reached tracking ($AMOUNT $UNIT)" || bad "quantity was $AMOUNT $UNIT"

ADDR=$(jq_body "d['tracking'].get('pickupAddress')")
echo "$ADDR" | grep -qi "MG Road" && ok "pickup address reached tracking" || bad "address was '$ADDR'"

BEST=$(jq_body "d['tracking'].get('bestBefore')")
# Drives the "best before 20:15" warning on a donation still waiting.
[ "$BEST" != "None" ] && [ -n "$BEST" ] && ok "bestBefore reached tracking" || bad "no bestBefore"

echo
echo "3. Impact counts only what was COLLECTED"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/stats/summary" >/dev/null
DELIVERED_BEFORE=$(jq_body "len(d['delivered'])")
# Food still sitting in a kitchen has not fed anyone. A dashboard that counted
# it would be flattering rather than true.
[ "$DELIVERED_BEFORE" = "0" ] && ok "an offered-but-uncollected donation counts zero delivered" || bad "delivered was $DELIVERED_BEFORE before collection"

echo
echo "4. Accept and collect it"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/engine/offers/$D1/accept")
[ "$code" = "200" ] && ok "agent accepted" || bad "accept got $code: $(body)"

code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $AGENT_TOKEN" \
  -X POST "$WEB/api/tracking/$D1/collected")
[ "$code" = "202" ] && ok "agent marked it collected" || bad "collect got $code"
sleep 6

echo
echo "5. The impact figures now count it"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/stats/summary" >/dev/null
SERVINGS=$(jq_body "sum(x['amount'] for x in d['delivered'] if x['unit']=='SERVINGS')")
[ "$SERVINGS" = "40" ] || [ "$SERVINGS" = "40.0" ] && ok "40 servings collected" || bad "servings totalled $SERVINGS"

COLLECTED=$(jq_body "d['counts']['COLLECTED']")
[ "$COLLECTED" = "1" ] && ok "one donation counted as collected" || bad "collected count was $COLLECTED"

echo
echo "6. Units are totalled separately, never summed together"
D2=$(post_donation "Fresh vegetables" 12 KG)
sleep 7
curl -s -o /dev/null -H "Authorization: Bearer $AGENT_TOKEN" -X POST "$WEB/api/engine/offers/$D2/accept"
sleep 2
curl -s -o /dev/null -H "Authorization: Bearer $AGENT_TOKEN" -X POST "$WEB/api/tracking/$D2/collected"
sleep 6

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/stats/summary" >/dev/null
UNITS=$(jq_body "sorted(x['unit'] for x in d['delivered'])")
# 40 servings plus 12 kg is not 52 of anything, so they stay separate.
if echo "$UNITS" | grep -q "KG" && echo "$UNITS" | grep -q "SERVINGS"; then
  ok "servings and kg are reported separately: $UNITS"
else
  bad "units were $UNITS"
fi
echo "         -> $(jq_body "', '.join('%s %s' % (x['amount'], x['unit'].lower()) for x in d['delivered'])")"

echo
echo "7. Matching performance, measured from the donor's side"
MATCHED=$(jq_body "d['matching']['matched'] if d.get('matching') else 0")
[ "$MATCHED" -ge 1 ] 2>/dev/null && ok "$MATCHED donations matched and measured" || bad "matching was $(jq_body "d.get('matching')")"
SECS=$(jq_body "d['matching']['avgSecondsToAccept'] if d.get('matching') else -1")
# The number that shows the assignment engine working: offer to acceptance,
# with no human in between.
[ "$SECS" -ge 0 ] 2>/dev/null && ok "average time from offer to acceptance: ${SECS}s" || bad "avgSecondsToAccept was $SECS"

echo
echo "8. The list carries what each card renders"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking?limit=50" >/dev/null
ROW_OK=$(jq_body "all(('title' in t and 'message' in t and 'status' in t) for t in d['tracking'])")
[ "$ROW_OK" = "True" ] && ok "every row has a title, a status and a human message" || bad "rows are missing fields"

# The list trims the timeline; the detail endpoint has the whole thing. Sending
# every entry for every row would grow without bound as donations are re-offered.
MAXT=$(jq_body "max((len(t.get('timeline',[])) for t in d['tracking']), default=0)")
[ "$MAXT" -le 3 ] 2>/dev/null && ok "the list trims the timeline to 3 entries per row" || bad "a row carried $MAXT timeline entries"

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/tracking/$D1" >/dev/null
FULLT=$(jq_body "len(d['tracking']['timeline'])")
[ "$FULLT" -ge 4 ] 2>/dev/null && ok "the detail view has the full history ($FULLT entries)" || bad "detail timeline had $FULLT entries"

echo
echo "9. Filtering by status, as the dashboard's chips do"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" \
  "$WEB/api/tracking?status=COLLECTED")
[ "$code" = "200" ] && ok "GET /api/tracking?status=COLLECTED" || bad "filter got $code"
ALL_COLLECTED=$(jq_body "all(t['status']=='COLLECTED' for t in d['tracking'])")
[ "$ALL_COLLECTED" = "True" ] && ok "the filter returns only collected donations" || bad "filter leaked other statuses"

echo
echo "10. The donor's updates inbox"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$WEB/api/notify?limit=10" >/dev/null
NOTES=$(jq_body "len(d['notifications'])")
[ "$NOTES" -ge 2 ] 2>/dev/null && ok "$NOTES updates for the donor" || bad "only $NOTES notifications"
# Accepted and collected, but nothing about individual offers or declines.
OFFERS=$(jq_body "sum(1 for n in d['notifications'] if n['kind']=='OFFER')")
[ "$OFFERS" = "0" ] && ok "no offer-level noise in the donor's inbox" || bad "donor got $OFFERS offer notifications"

echo
echo "Cleaning up..."
rcli ZREM agents:live "$AGENT_ID" >/dev/null
rcli DEL "agent:$AGENT_ID:caps" "agent:$AGENT_ID:alive" "agent:$AGENT_ID:load" >/dev/null
for d in "$D1" "$D2"; do
  [ -n "$d" ] || continue
  rcli DEL "donation:$d:offer" "donation:$d:claimed" "donation:$d:declined" >/dev/null
done
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

#!/usr/bin/env bash
# Phase 7 acceptance test: tracking-service and notification-service.
#
# Phase 6 made the system decide correctly. This proves it now TELLS SOMEBODY:
# the donor sees where their donation is, the agent sees a collection request,
# and the losing agents are told the offer closed rather than tapping a button
# that returns 409.
#
# No EXIT trap: an EXIT trap also fires when a command-substitution subshell
# exits, and this script calls its helpers as $(...) throughout.
set -uo pipefail
export MSYS_NO_PATHCONV=1

AUTH="${AUTH_BASE_URL:-http://localhost:4001}"
DON="${DONATION_BASE_URL:-http://localhost:4002}"
LOC="${LOCATION_BASE_URL:-http://localhost:4004}"
ENG="${ENGINE_BASE_URL:-http://localhost:4005}"
TRK="${TRACKING_BASE_URL:-http://localhost:4006}"
NOT="${NOTIFICATION_BASE_URL:-http://localhost:4007}"
STAMP=$(date +%s)
pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

BODY="./.trk-body.$STAMP"
body() { cat "$BODY" 2>/dev/null; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_body() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$BODY" 2>/dev/null; }

PLAT=12.9757
PLNG=77.6068
AGENT_IDS=()
A_TOKENS=()

place_agent() {
  local label="$1" lat="$2" lng="$3"
  curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"role\":\"AGENT\",\"name\":\"$label\",\"email\":\"${label}_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
  local tok id
  tok=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
  id=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
  curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
    -X POST "$LOC/agents/location" -d "{\"lat\":$lat,\"lng\":$lng}"
  echo "$tok $id"
}

echo "=============================================="
echo " HungerHeal Phase 7 - tracking + notifications"
echo "=============================================="

echo
echo "1. Both services are up"
code=$(curl -s -o "$BODY" -w '%{http_code}' "$TRK/ready")
if [ "$code" = "200" ] && body | grep -q '"kafka":"up"'; then
  ok "tracking-service ready, consuming from kafka"
else bad "tracking /ready: $(body)"; fi

code=$(curl -s -o "$BODY" -w '%{http_code}' "$NOT/ready")
if [ "$code" = "200" ] && body | grep -q '"kafka":"up"'; then
  ok "notification-service ready, consuming from kafka"
else bad "notification /ready: $(body)"; fi

echo
echo "2. Setting up a donor and three agents"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"Asha\",\"email\":\"trkdonor_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
DONOR_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)

read -r A1_TOKEN A1_ID < <(place_agent "trkalpha" 12.9760 77.6070)
read -r A2_TOKEN A2_ID < <(place_agent "trkbravo" 12.9765 77.6075)
read -r A3_TOKEN A3_ID < <(place_agent "trkcharlie" 12.9770 77.6080)
AGENT_IDS=("$A1_ID" "$A2_ID" "$A3_ID")
[ -n "$A3_ID" ] && ok "donor and three agents registered" || bad "setup failed"

echo
echo "3. A donation is created and offered"
BB=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
TRACE="p7-smoke-$STAMP"
curl -s -o "$BODY" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DONOR_TOKEN" -H "x-trace-id: $TRACE" \
  -X POST "$DON/donations" \
  -d "{\"title\":\"Leftover biryani\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":30,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":$PLAT,\"lng\":$PLNG,\"bestBefore\":\"$BB\"}"
DONATION_ID=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
[ -n "$DONATION_ID" ] && ok "donation created: $DONATION_ID" || bad "create failed: $(body)"

echo "         -> waiting for the event pipeline..."
sleep 8

echo
echo "4. TRACKING - the donor can see where it is"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" "$TRK/tracking/$DONATION_ID")
[ "$code" = "200" ] && ok "GET /tracking/:id" || bad "tracking got $code: $(body)"

STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "OFFERED" ] && ok "status is OFFERED - agents have been asked" || bad "status was '$STATUS'"

MESSAGE=$(jq_body "d['tracking']['message']")
# The donor gets a sentence, not an enum.
if [ -n "$MESSAGE" ] && [ "$MESSAGE" != "$STATUS" ]; then
  ok "donor-facing message: \"$MESSAGE\""
else bad "no human-readable message"; fi

TIMELINE=$(jq_body "len(d['tracking']['timeline'])")
[ "$TIMELINE" -ge 2 ] 2>/dev/null && ok "timeline has $TIMELINE entries - created, then offered" || bad "timeline had $TIMELINE entries"

echo "         -> $(jq_body "' | '.join(t['summary'][:60] for t in d['tracking']['timeline'])")"

OFFERED_COUNT=$(jq_body "d['tracking']['agentsOffered']")
[ "$OFFERED_COUNT" = "3" ] && ok "recorded that 3 agents were offered it" || bad "agentsOffered was $OFFERED_COUNT"

TRK_TRACE=$(jq_body "d['tracking']['traceId']")
[ "$TRK_TRACE" = "$TRACE" ] && ok "the donor's traceId reached tracking-service" || bad "trace was '$TRK_TRACE'"

echo
echo "5. NOTIFICATIONS - the agents were actually told"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $A1_TOKEN" "$NOT/notifications")
[ "$code" = "200" ] && ok "GET /notifications" || bad "notifications got $code"

OFFER_COUNT=$(jq_body "sum(1 for n in d['notifications'] if n['kind']=='OFFER' and n['donationId']=='$DONATION_ID')")
[ "$OFFER_COUNT" = "1" ] && ok "the agent has a collection request for this donation" || bad "expected 1 OFFER, got $OFFER_COUNT"

OFFER_TITLE=$(jq_body "[n['title'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")
echo "         -> \"$OFFER_TITLE\""
OFFER_BODY=$(jq_body "[n['body'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")
echo "         -> \"$OFFER_BODY\""
# The address is what decides the answer, so it must be in the message.
echo "$OFFER_BODY" | grep -qi "MG Road" && ok "the request names the pickup address" || bad "no address in the offer"
echo "$OFFER_BODY" | grep -q "90 seconds" && ok "the request states the 90 second window" || bad "no deadline in the offer"

EXPIRES=$(jq_body "[n['expiresAt'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")
[ "$EXPIRES" != "None" ] && [ -n "$EXPIRES" ] && ok "the offer carries an expiry, so the app can count down" || bad "no expiresAt"

# All three agents, not just one - this is the parallel offer made visible.
NOTIFIED=0
for tok in "$A1_TOKEN" "$A2_TOKEN" "$A3_TOKEN"; do
  curl -s -o "$BODY" -H "Authorization: Bearer $tok" "$NOT/notifications" >/dev/null
  n=$(jq_body "sum(1 for x in d['notifications'] if x['donationId']=='$DONATION_ID' and x['kind']=='OFFER')")
  [ "$n" = "1" ] && NOTIFIED=$((NOTIFIED+1))
done
[ "$NOTIFIED" = "3" ] && ok "all three agents were notified in parallel" || bad "only $NOTIFIED of 3 agents notified"

echo
echo "6. The donor was NOT spammed about the offer"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$NOT/notifications" >/dev/null
DONOR_OFFERS=$(jq_body "sum(1 for n in d['notifications'] if n['kind']=='OFFER')")
# A donor does not need a notification per offer round; that is noise that
# teaches people to ignore the app.
[ "$DONOR_OFFERS" = "0" ] && ok "the donor received no offer notifications" || bad "donor got $DONOR_OFFERS offer notifications"

echo
echo "7. An agent accepts"
ACCEPTOR_TOKEN="$A1_TOKEN"; ACCEPTOR_ID="$A1_ID"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ACCEPTOR_TOKEN" -X POST "$ENG/offers/$DONATION_ID/accept")
if [ "$code" != "200" ]; then
  # Whoever was ranked first may differ; try the others.
  for pair in "$A2_TOKEN:$A2_ID" "$A3_TOKEN:$A3_ID"; do
    t="${pair%%:*}"; i="${pair##*:}"
    code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $t" -X POST "$ENG/offers/$DONATION_ID/accept")
    [ "$code" = "200" ] && { ACCEPTOR_TOKEN="$t"; ACCEPTOR_ID="$i"; break; }
  done
fi
[ "$code" = "200" ] && ok "an agent accepted the donation" || bad "accept got $code: $(body)"

sleep 6

echo
echo "8. Everyone is told what happened"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$NOT/notifications" >/dev/null
DONOR_UPDATE=$(jq_body "[n['body'] for n in d['notifications'] if n['donationId']=='$DONATION_ID' and n['kind']=='DONATION_UPDATE']")
if echo "$DONOR_UPDATE" | grep -qi "accepted\|on the way"; then
  ok "the donor was told an agent is coming"
  echo "         -> $(jq_body "[n['body'] for n in d['notifications'] if n['donationId']=='$DONATION_ID'][0]")"
else bad "the donor was not notified of the acceptance: $DONOR_UPDATE"; fi

# The losing agents must be told, or their app counts down an offer that is
# already gone and Accept returns 409.
CLOSED=0
for pair in "$A1_TOKEN:$A1_ID" "$A2_TOKEN:$A2_ID" "$A3_TOKEN:$A3_ID"; do
  t="${pair%%:*}"; i="${pair##*:}"
  [ "$i" = "$ACCEPTOR_ID" ] && continue
  curl -s -o "$BODY" -H "Authorization: Bearer $t" "$NOT/notifications?includeExpired=true" >/dev/null
  n=$(jq_body "sum(1 for x in d['notifications'] if x['donationId']=='$DONATION_ID' and x['kind']=='OFFER_CLOSED')")
  [ "$n" -ge 1 ] 2>/dev/null && CLOSED=$((CLOSED+1))
done
[ "$CLOSED" = "2" ] && ok "both losing agents were told the request closed" || bad "only $CLOSED of 2 losers were told"

echo
echo "9. Tracking reflects the acceptance"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$TRK/tracking/$DONATION_ID" >/dev/null
STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "ACCEPTED" ] && ok "status is ACCEPTED" || bad "status was '$STATUS'"

AGENT_NAME=$(jq_body "d['tracking']['assignedAgentName']")
[ -n "$AGENT_NAME" ] && [ "$AGENT_NAME" != "None" ] && ok "the assigned agent is named: $AGENT_NAME" || bad "no assigned agent recorded"

PHONE=$(jq_body "d['tracking']['assignedAgentPhone']")
# A name without a number is not actionable when the agent is at the wrong gate.
[ -n "$PHONE" ] && [ "$PHONE" != "None" ] && ok "the donor can see the agent's phone number" || bad "no agent phone"

echo
echo "10. The agent marks it collected"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $ACCEPTOR_TOKEN" \
  -X POST "$TRK/tracking/$DONATION_ID/collected")
[ "$code" = "202" ] && ok "collection accepted (202 - it completes when the event is consumed)" || bad "collected got $code: $(body)"

sleep 6
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$TRK/tracking/$DONATION_ID" >/dev/null
STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "COLLECTED" ] && ok "status is COLLECTED" || bad "status was '$STATUS'"

COLLECTED_AT=$(jq_body "d['tracking']['collectedAt']")
[ "$COLLECTED_AT" != "None" ] && ok "collectedAt recorded for analytics" || bad "no collectedAt"

curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$NOT/notifications" >/dev/null
if jq_body "[n['title'] for n in d['notifications'] if n['donationId']=='$DONATION_ID']" | grep -qi "collected"; then
  ok "the donor was thanked"
else bad "no collection notification for the donor"; fi

echo
echo "11. Only the agent who accepted can collect"
OTHER_TOKEN="$A2_TOKEN"; [ "$ACCEPTOR_ID" = "$A2_ID" ] && OTHER_TOKEN="$A3_TOKEN"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $OTHER_TOKEN" \
  -X POST "$TRK/tracking/$DONATION_ID/collected")
# Without this check any agent could close out somebody else's pickup.
[ "$code" = "403" ] || [ "$code" = "400" ] && ok "another agent cannot mark it collected ($code)" || bad "expected 403/400, got $code"

echo
echo "12. Authorization on tracking"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"Nosy\",\"email\":\"nosy_${STAMP}@example.com\",\"phone\":\"+91 9000000009\",\"password\":\"goodpass1\"}" >/dev/null
NOSY_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $NOSY_TOKEN" "$TRK/tracking/$DONATION_ID")
# A 403 would confirm the id is real; a 404 reveals nothing.
[ "$code" = "404" ] && ok "an unrelated donor gets 404, not 403" || bad "expected 404, got $code"

code=$(curl -s -o "$BODY" -w '%{http_code}' "$TRK/tracking/$DONATION_ID")
[ "$code" = "401" ] && ok "unauthenticated tracking rejected" || bad "expected 401, got $code"

echo
echo "13. The terminal state holds"
# A redelivered donation.assigned must not resurrect a collected donation.
printf '%s\n' "{\"eventId\":\"replay-$STAMP\",\"eventType\":\"donation.assigned\",\"donationId\":\"$DONATION_ID\",\"donorId\":\"$DONOR_ID\",\"category\":\"COOKED_PREPARED\",\"traceId\":\"$TRACE\",\"round\":9,\"offers\":[{\"agentId\":\"$A2_ID\",\"agentName\":\"Late\",\"rank\":1,\"score\":0.5}],\"responseTimeoutSeconds\":90,\"pickup\":{\"address\":\"MG Road\"}}" \
  | docker exec -i hh-kafka /opt/kafka/bin/kafka-console-producer.sh \
    --bootstrap-server localhost:9092 --topic donation.assigned >/dev/null 2>&1
REPLAY_RC=$?
[ "$REPLAY_RC" = "0" ] && ok "a late donation.assigned was genuinely published" || bad "replay failed"

sleep 6
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$TRK/tracking/$DONATION_ID" >/dev/null
STATUS=$(jq_body "d['tracking']['status']")
[ "$STATUS" = "COLLECTED" ] && ok "the collected donation was NOT dragged back to OFFERED" || bad "status became '$STATUS'"

echo
echo "14. Summary endpoint"
code=$(curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $DONOR_TOKEN" "$TRK/tracking/stats/summary")
[ "$code" = "200" ] && ok "GET /tracking/stats/summary" || bad "summary got $code"
COLLECTED_N=$(jq_body "d['counts']['COLLECTED']")
[ "$COLLECTED_N" -ge 1 ] 2>/dev/null && ok "the donor's summary counts $COLLECTED_N collected" || bad "summary count was $COLLECTED_N"

echo
echo "15. Marking notifications read"
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$NOT/notifications/unread-count" >/dev/null
BEFORE=$(jq_body "d['unreadCount']")
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" -X POST "$NOT/notifications/read-all" >/dev/null
curl -s -o "$BODY" -H "Authorization: Bearer $DONOR_TOKEN" "$NOT/notifications/unread-count" >/dev/null
AFTER=$(jq_body "d['unreadCount']")
if [ "$BEFORE" -gt 0 ] 2>/dev/null && [ "$AFTER" = "0" ]; then
  ok "unread count went from $BEFORE to 0"
else bad "unread count was $BEFORE then $AFTER"; fi

echo
echo "Cleaning up..."
for id in "${AGENT_IDS[@]}"; do
  [ -n "$id" ] || continue
  rcli ZREM agents:live "$id" >/dev/null
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done
rcli ZREM offers:deadlines "$DONATION_ID" >/dev/null
rcli DEL "donation:$DONATION_ID:offer" "donation:$DONATION_ID:claimed" "donation:$DONATION_ID:declined" >/dev/null
rm -f "$BODY"

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

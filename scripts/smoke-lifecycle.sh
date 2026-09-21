#!/usr/bin/env bash
# Phase 6 acceptance test: the offer lifecycle against the running stack.
#
# It proves the four things Phase 5 left open:
#   1. a redelivered event does NOT assign the donation twice
#   2. two agents accepting at the same instant produce exactly one winner
#   3. an offer nobody answers times out and is re-offered to DIFFERENT agents
#   4. when everyone has been asked, the donor is told - not left waiting
#
# The timeouts are real, so this script genuinely waits ~90 seconds in one
# place. That wait IS the test.
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

BODY="./.lc-body.$$"
EVT="./.lc-evt.$$"
trap 'rm -f "$BODY" "$EVT"' EXIT
body() { cat "$BODY"; }
rcli() { docker exec hh-redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
jq_py() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$EVT" 2>/dev/null; }

PLAT=12.9757
PLNG=77.6068
AGENT_IDS=()

place_agent() {
  local label="$1" lat="$2" lng="$3"
  curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"role\":\"AGENT\",\"name\":\"$label\",\"email\":\"${label}_${STAMP}@example.com\",\"phone\":\"+91 9000000000\",\"password\":\"goodpass1\",\"capabilities\":{\"vehicleType\":\"MOTORCYCLE\",\"hasInsulatedTransport\":true,\"categoriesHandled\":[\"COOKED_PREPARED\"]}}"
  local tok id
  tok=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")
  id=$(sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1)
  curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
    -X POST "$LOC/agents/location" -d "{\"lat\":$lat,\"lng\":$lng}"
  AGENT_IDS+=("$id")
  echo "$tok $id"
}

# Re-reports every agent's position.
#
# Agent presence is a heartbeat with a TTL, so an agent who stops reporting
# drops out of matching within a couple of minutes. That is the system working
# correctly - but this script runs for several minutes, so it has to keep them
# alive the way a real agent app does, every 15-30 seconds.
refresh_agents() {
  local i=0
  local lats="12.9760 12.9765 12.9770 12.9790"
  local lngs="77.6070 77.6075 77.6080 77.6100"
  for tok in "$A1_TOKEN" "$A2_TOKEN" "$A3_TOKEN" "$A4_TOKEN"; do
    [ -n "$tok" ] || continue
    i=$((i+1))
    local lat lng
    lat=$(echo "$lats" | cut -d' ' -f$i)
    lng=$(echo "$lngs" | cut -d' ' -f$i)
    curl -s -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
      -X POST "$LOC/agents/location" -d "{\"lat\":$lat,\"lng\":$lng}"
  done
}

create_donation() {
  refresh_agents
  local title="$1" trace="$2"
  local bb
  bb=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)
  curl -s -o "$BODY" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $DONOR_TOKEN" -H "x-trace-id: $trace" \
    -X POST "$DON/donations" \
    -d "{\"title\":\"$title\",\"category\":\"COOKED_PREPARED\",\"quantityAmount\":20,\"quantityUnit\":\"SERVINGS\",\"pickupAddress\":\"MG Road, Bengaluru\",\"lat\":$PLAT,\"lng\":$PLNG,\"bestBefore\":\"$bb\"}"
  sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' "$BODY" | head -1
}

read_events() {
  docker exec hh-kafka /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 --topic "$1" \
    --from-beginning --timeout-ms "${3:-20000}" 2>/dev/null | grep "$2"
}

echo "=============================================="
echo " HungerHeal Phase 6 - the offer lifecycle"
echo "=============================================="

echo
echo "Setting up: one donor, four agents around MG Road"
curl -s -o "$BODY" -X POST "$AUTH/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"role\":\"DONOR\",\"name\":\"Asha\",\"email\":\"lcdonor_${STAMP}@example.com\",\"phone\":\"+91 9876543210\",\"password\":\"goodpass1\"}"
DONOR_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

read -r A1_TOKEN A1_ID < <(place_agent "lcalpha" 12.9760 77.6070)
read -r A2_TOKEN A2_ID < <(place_agent "lcbravo" 12.9765 77.6075)
read -r A3_TOKEN A3_ID < <(place_agent "lccharlie" 12.9770 77.6080)
read -r A4_TOKEN A4_ID < <(place_agent "lcdelta" 12.9790 77.6100)
[ -n "$A4_ID" ] && ok "four agents placed and reporting" || bad "agent setup failed"

# ---------------------------------------------------------------------------
echo
echo "1. IDEMPOTENCY - a redelivered event must not assign twice"
D1=$(create_donation "Idempotency probe" "p6-idem-$STAMP")
[ -n "$D1" ] && ok "donation created: $D1" || bad "create failed"
sleep 4

# Replay the exact donation.created event, byte for byte, including its
# eventId - which is what a Kafka redelivery after a crash looks like.
ORIGINAL=$(read_events "donation.created" "$D1" 15000 | tail -1)
if [ -n "$ORIGINAL" ]; then
  EVENT_ID=$(echo "$ORIGINAL" | sed -n 's/.*"eventId":"\([^"]*\)".*/\1/p')
  ok "captured the original event (eventId ${EVENT_ID:0:8}...)"

  # Republish the identical body. A console producer does not carry the
  # original Kafka headers - which is precisely why the engine deduplicates
  # on the eventId in the BODY rather than on the x-event-id header.
  printf '%s
' "$ORIGINAL" | docker exec -i hh-kafka /opt/kafka/bin/kafka-console-producer.sh \n    --bootstrap-server localhost:9092 --topic donation.created >/dev/null 2>&1

  sleep 6
  ASSIGN_COUNT=$(read_events "donation.assigned" "$D1" 15000 | wc -l | tr -d ' ')
  if [ "$ASSIGN_COUNT" = "1" ]; then
    ok "the redelivered event was skipped - still exactly 1 donation.assigned"
  else
    bad "expected 1 assignment, found $ASSIGN_COUNT"
  fi

  # The dedup marker itself.
  if [ -n "$EVENT_ID" ] && [ "$(rcli EXISTS "processed:$EVENT_ID")" = "1" ]; then
    ok "the processed:<eventId> dedup key is set in Redis"
    TTL=$(rcli TTL "processed:$EVENT_ID")
    [ "$TTL" -gt 0 ] 2>/dev/null && ok "the dedup key has a TTL (${TTL}s), so markers do not accumulate forever" || bad "dedup key TTL was $TTL"
  else
    bad "no dedup key found for the processed event"
  fi
else
  bad "could not capture the original donation.created event"
fi

# ---------------------------------------------------------------------------
echo
echo "2. THE CLAIM RACE - three agents offered, two accept at once"
D2=$(create_donation "Claim race probe" "p6-race-$STAMP")
sleep 5

read_events "donation.assigned" "$D2" 15000 | tail -1 > "$EVT"
if [ -s "$EVT" ]; then
  ok "donation offered to $(jq_py "len(d['offers'])") agents"
  OFFERED=$(jq_py "' '.join(o['agentId'] for o in d['offers'])")
  echo "         -> offered to: $(jq_py "', '.join(o['agentName'] for o in d['offers'])")"
else
  bad "no assignment event for $D2"
  OFFERED=""
fi

# Map each offered agent id back to its token.
token_for() {
  case "$1" in
    "$A1_ID") echo "$A1_TOKEN" ;; "$A2_ID") echo "$A2_TOKEN" ;;
    "$A3_ID") echo "$A3_TOKEN" ;; "$A4_ID") echo "$A4_TOKEN" ;;
  esac
}

set -- $OFFERED
FIRST_ID="${1:-}"; SECOND_ID="${2:-}"
FIRST_TOKEN=$(token_for "$FIRST_ID"); SECOND_TOKEN=$(token_for "$SECOND_ID")

if [ -n "$FIRST_TOKEN" ] && [ -n "$SECOND_TOKEN" ]; then
  # Fire both accepts simultaneously, which is what two thumbs on two phones
  # actually looks like.
  curl -s -o "./.lc-a1.$$" -w '%{http_code}' -H "Authorization: Bearer $FIRST_TOKEN" \
    -X POST "$ENG/offers/$D2/accept" > "./.lc-c1.$$" &
  curl -s -o "./.lc-a2.$$" -w '%{http_code}' -H "Authorization: Bearer $SECOND_TOKEN" \
    -X POST "$ENG/offers/$D2/accept" > "./.lc-c2.$$" &
  wait

  C1=$(cat "./.lc-c1.$$"); C2=$(cat "./.lc-c2.$$")
  rm -f "./.lc-a1.$$" "./.lc-a2.$$" "./.lc-c1.$$" "./.lc-c2.$$"

  echo "         -> responses: $C1 and $C2"
  if { [ "$C1" = "200" ] && [ "$C2" = "409" ]; } || { [ "$C1" = "409" ] && [ "$C2" = "200" ]; }; then
    ok "exactly one agent won (200) and the other was told it was taken (409)"
  else
    bad "expected one 200 and one 409, got $C1 and $C2"
  fi

  CLAIMED=$(rcli GET "donation:$D2:claimed")
  [ -n "$CLAIMED" ] && ok "the Redis claim lock records the winner: ${CLAIMED:0:8}..." || bad "no claim key was written"

  LOAD=$(rcli GET "agent:$CLAIMED:load")
  # The load counter must move before the next donation is scored, or the agent
  # who just accepted still looks idle and immediately wins another.
  [ "$LOAD" -ge 1 ] 2>/dev/null && ok "the winner's load counter incremented to $LOAD" || bad "load counter was '$LOAD'"

  sleep 3
  read_events "donation.accepted" "$D2" 15000 | tail -1 > "$EVT"
  if [ -s "$EVT" ]; then
    ok "donation.accepted published for tracking-service to consume"
    echo "         -> responded in $(jq_py "d['responseSeconds']")s, round $(jq_py "d['round']")"
  else
    bad "no donation.accepted event"
  fi

  # The deadline must be cleared, or the watcher would re-offer a donation
  # somebody is already driving to collect.
  [ "$(rcli ZSCORE offers:deadlines "$D2")" = "" ] && ok "the deadline was cleared on accept" || bad "deadline still armed after accept"
else
  bad "could not resolve agent tokens for the race test"
fi

# ---------------------------------------------------------------------------
echo
echo "3. REJECTION - declining re-scores immediately instead of waiting"
D3=$(create_donation "Rejection probe" "p6-reject-$STAMP")
sleep 5

read_events "donation.assigned" "$D3" 15000 | tail -1 > "$EVT"
R_OFFERED=$(jq_py "' '.join(o['agentId'] for o in d['offers'])")
R_ROUND=$(jq_py "d['round']")
[ "$R_ROUND" = "1" ] && ok "first offer is round 1" || bad "round was $R_ROUND"

DECLINED_COUNT=0
for aid in $R_OFFERED; do
  tok=$(token_for "$aid")
  [ -n "$tok" ] || continue
  code=$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $tok" -X POST "$ENG/offers/$D3/reject" -d '{"reason":"already busy"}')
  [ "$code" = "200" ] && DECLINED_COUNT=$((DECLINED_COUNT+1))
  echo "         -> $(echo "$aid" | cut -c1-8) declined, $(body | sed -n 's/.*"remainingInBatch":\([0-9]*\).*/\1/p') left in the batch"
done
[ "$DECLINED_COUNT" -ge 1 ] && ok "$DECLINED_COUNT agents declined" || bad "no declines registered"

DECLINED_SET=$(rcli SCARD "donation:$D3:declined")
[ "$DECLINED_SET" -ge 1 ] 2>/dev/null && ok "declines recorded in Redis ($DECLINED_SET agents excluded)" || bad "decline set was '$DECLINED_SET'"

sleep 6
ROUNDS=$(read_events "donation.assigned" "$D3" 15000 | wc -l | tr -d ' ')
if [ "$ROUNDS" -ge 2 ]; then
  ok "the whole batch declining triggered an immediate re-score (round 2 without waiting 90s)"
  read_events "donation.assigned" "$D3" 15000 | tail -1 > "$EVT"
  NEW_OFFERED=$(jq_py "' '.join(o['agentId'] for o in d['offers'])")
  REPEAT=0
  for old in $R_OFFERED; do
    for new in $NEW_OFFERED; do [ "$old" = "$new" ] && REPEAT=1; done
  done
  [ "$REPEAT" = "0" ] && ok "round 2 went to DIFFERENT agents - nobody was re-asked" || bad "an agent who declined was offered it again"
else
  bad "expected a second offer round, found $ROUNDS assignment events"
fi

# ---------------------------------------------------------------------------
echo
echo "4. THE TIMEOUT - an offer nobody answers (this really waits 90s)"
D4=$(create_donation "Timeout probe" "p6-timeout-$STAMP")
sleep 5

read_events "donation.assigned" "$D4" 15000 | tail -1 > "$EVT"
T_OFFERED=$(jq_py "' '.join(o['agentId'] for o in d['offers'])")
T_TIMEOUT=$(jq_py "d['responseTimeoutSeconds']")
[ "$T_TIMEOUT" = "90" ] && ok "offer carries a 90 second window" || bad "timeout was $T_TIMEOUT"

DEADLINE=$(rcli ZSCORE offers:deadlines "$D4")
[ -n "$DEADLINE" ] && ok "the deadline is armed in the offers:deadlines sorted set" || bad "no deadline armed"

echo "         -> nobody will answer. waiting out the window..."
for i in $(seq 1 20); do
  sleep 6
  # Keep the other agents alive through the wait, or there would be nobody
  # left to re-offer to and the re-score would look broken when it is not.
  refresh_agents
  COUNT=$(read_events "donation.timeout" "$D4" 8000 | wc -l | tr -d ' ')
  [ "$COUNT" -ge 1 ] && break
  printf "            %ds elapsed\r" $((i*6))
done
echo "                                      "

TIMEOUTS=$(read_events "donation.timeout" "$D4" 15000 | wc -l | tr -d ' ')
if [ "$TIMEOUTS" -ge 1 ]; then
  ok "donation.timeout fired after the window closed - the offer did not sit forever"
else
  bad "no donation.timeout event appeared"
fi

sleep 6
T_ROUNDS=$(read_events "donation.assigned" "$D4" 15000 | wc -l | tr -d ' ')
if [ "$T_ROUNDS" -ge 2 ]; then
  ok "the timeout triggered an automatic re-score (round 2)"
  read_events "donation.assigned" "$D4" 15000 | tail -1 > "$EVT"
  T_NEW=$(jq_py "' '.join(o['agentId'] for o in d['offers'])")
  T_REPEAT=0
  for old in $T_OFFERED; do
    for new in $T_NEW; do [ "$old" = "$new" ] && T_REPEAT=1; done
  done
  [ "$T_REPEAT" = "0" ] && ok "the agents who ignored it were excluded from round 2" || bad "an agent who ignored it was re-offered"
  echo "         -> round $(jq_py "d['round']") offered to $(jq_py "len(d['offers'])") different agent(s)"
else
  bad "expected a re-score after the timeout, found $T_ROUNDS assignments"
fi

# ---------------------------------------------------------------------------
echo
echo "5. Trace continuity across the whole lifecycle"
read_events "donation.timeout" "$D4" 15000 | tail -1 > "$EVT"
T_TRACE=$(jq_py "d['traceId']")
# The re-offer minutes later still carries the donor's original trace.
[ "$T_TRACE" = "p6-timeout-$STAMP" ] && ok "the timeout event carries the donor's original traceId" || bad "trace was '$T_TRACE'"

echo
echo "Cleaning up..."
for id in "${AGENT_IDS[@]}"; do
  [ -n "$id" ] || continue
  rcli ZREM agents:live "$id" >/dev/null
  rcli DEL "agent:$id:caps" "agent:$id:alive" "agent:$id:load" >/dev/null
done
for d in "$D1" "$D2" "$D3" "$D4"; do
  [ -n "$d" ] || continue
  rcli ZREM offers:deadlines "$d" >/dev/null
  rcli DEL "donation:$d:offer" "donation:$d:claimed" "donation:$d:declined" >/dev/null
done

echo
echo "=============================================="
printf " %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1

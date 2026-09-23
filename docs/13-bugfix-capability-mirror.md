# The capability mirror bug — an agent who was invisible to matching

Found by using the app, not by a test. An agent with **all five food
categories** on record, on shift, 380m from a cooked-food donation, was never
offered it. Distance made no difference; neither did equipment.

This is the write-up because the shape of the bug is more instructive than the
fix: **three correct components, and a data invariant none of them owned.**

---

## The symptom

```
"no agent could be matched"  reason: NO_ELIGIBLE_AGENTS
radiusKm: 50   candidatesFound: 1   category: COOKED_PREPARED
```

`candidatesFound: 1` is the interesting part. The agent **was** found —
geospatially, at every radius up to 50km. They were then ruled ineligible.

Redis said why:

```
agent:<id>:caps  →  available: 1
```

One field. No `categories`, no `insulated`, no `name`. Meanwhile auth-service
held a complete record: five categories, insulated *and* refrigerated.

Category eligibility is a **hard filter**, so an empty category list is not "a
low score" — it is exclusion from every donation in the system.

---

## The mechanism

Three things, each defensible alone:

1. **`SetAvailability` does `HSET agent:<id>:caps available 1`.** In Redis,
   `HSET` **creates** the hash if it does not exist.
2. **`HasCapabilities` was `EXISTS agent:<id>:caps`.**
3. **The capability mirror ran only on a location report**, and only when
   `HasCapabilities` was false.

So: availability arrives first → the hash exists → `HasCapabilities` returns
true → the mirror is skipped → **and is skipped forever**, because the condition
that would trigger it is the very thing the stub satisfied. The agent is on the
map, heartbeat healthy, available, and eligible for nothing.

### Why availability arrived first

`useAgentLocation.start()` set `sharing = true` **synchronously**. But
`watchPosition` is asynchronous, and with `enableHighAccuracy: true` the first
fix can take seconds — longer while the permission prompt is open. In that
window:

- the UI said **"On shift"** and rendered the availability toggle,
- the immediate `report()` hit `if (!current) return` and **sent nothing**,
- so anything the agent touched reached the server *before* their first
  location report.

The UI was claiming the agent was matchable while the server had never heard
from them. That was a real bug on its own, and it is what opened the window.

---

## Why every test missed it

**All 333 smoke checks and 14 store tests passed throughout.** They set an
agent up by reporting a location first, because that is the natural way to
write it:

```bash
place_agent() { signup; report_location; }   # mirror runs, caps complete
```

Nothing exercised availability-before-location, so nothing exercised the one
ordering that breaks. The test suite was not weak; it encoded the happy path's
ordering as though it were the only ordering.

**The lesson worth keeping:** when two endpoints write the same key, the tests
must cover *both orders*, not just the one the UI happens to produce today. A
UI change — or a slow GPS — is enough to swap them.

---

## The fix

Five parts. The first two make ordering irrelevant rather than making one order
correct; the fourth exists because the fix reopened the bug elsewhere.

### 1. A sentinel field instead of `EXISTS`

```go
capsCompleteField = "updatedAt"   // written by SaveCapabilities alone

func (s *Store) HasCapabilities(ctx context.Context, agentID string) (bool, error) {
	return s.rdb.HExists(ctx, CapsKey(agentID), capsCompleteField).Result()
}
```

`EXISTS` answered "is there a hash?" when the question was "is there a
**complete mirror**?". Only `SaveCapabilities` writes `updatedAt`, so only
`SaveCapabilities` can satisfy the check, so a hash created by any other write
stays **retryable**. (Making the *degraded* write retryable took one more
change — see part 4.)

### 2. Every first-contact endpoint mirrors

The mirror moved into `ensureCapabilities`, called from **both**
`UpdateLocation` and `SetAvailability` — before the availability write, not
after. Whichever request arrives first now populates the full record.

### 3. `available` is live state, not registration data

```go
// Only seeded when nothing has set it.
if err == redis.Nil || existing == "" {
	fields["available"] = boolToStr(a.Available)
}
```

Once (1) and (2) were in, a new bug became reachable: auth-service defaults
`available` to `true`, so a mirror running *after* an agent had turned
availability **off** would silently switch them back on. Registration data must
not overwrite a decision the agent made thirty seconds ago.

### 4. A degraded write must not look finished

Adding the sentinel opened the same trap one door along. When auth-service is
unreachable the service stores what the token carries — name, phone — and
`SaveCapabilities` would have stamped `updatedAt` on it. That stub would then
report itself as a complete mirror **with no categories**, and the agent would
be hard-filtered out of every donation until something deleted the key: the
original bug, reintroduced by its own fix.

```go
// Writes name/phone/rating and deliberately NOT the sentinel.
func (s *Store) SavePartialProfile(ctx, agentID, a) error
```

`HasCapabilities` keeps returning false, so the next request retries and
completes the mirror once auth-service recovers. Caught while re-reading the
diff — the comment claimed the stub stayed retryable, and the code did the
opposite.

### 5. The shift starts at the first GPS fix

`sharing` now becomes true in the `watchPosition` success callback, not at the
tap. A new `acquiring` state covers the gap, so the panel reads **"Finding your
location…"** and offers **Cancel** — and never claims an agent is matchable
while the server has heard nothing.

---

## Verification

Four regression tests. The three covering the original bug were each
**confirmed to fail against the old code** before being kept — a test that passes either way is worse than no test, which this
project has already learned once (see
[Phase 6](06-phase6-offer-lifecycle.md)).

| Test | What it pins |
|---|---|
| `TestSetAvailabilityDoesNotFakeACapabilityRecord` | A stub hash is not a mirror |
| `TestAgentIsMatchableWhenAvailabilityPrecedesFirstLocation` | The broken order end-to-end, through `Nearby` |
| `TestMirroringDoesNotResurrectAvailability` | Mirroring cannot re-enable a paused agent |
| `TestPartialProfileStaysRetryable` | A degraded write stays pending, and completes on recovery |

The second test initially passed against the old code too — because its agent
ids did not match the suite's `agent:test-*` cleanup pattern, so stale keys from
the previous run carried the categories. Fixed by using the suite's id
convention. Worth recording: **the near-miss was the same failure mode as the
bug** — state left behind by one path silently satisfying another.

Store tests: **14 → 18, all passing.**

### Live confirmation

Availability-first, then location, through the gateway:

```
caps after the availability call alone:
  categories COOKED_PREPARED · insulated 1 · refrigerated 1 · updatedAt … ✅
```

Then a cooked-food donation 380m away — **matched on round 1.**

### Existing poisoned records

Two live agents were already broken. A stub hash is now detectable, so they
were repaired by deleting the incomplete key and letting the next call rebuild
it from auth-service:

```bash
docker exec hh-redis redis-cli --scan --pattern 'agent:*:caps' | while read k; do
  [ "$(docker exec hh-redis redis-cli HEXISTS "$k" updatedAt)" = "0" ] \
    && docker exec hh-redis redis-cli DEL "$k"
done
```

This is safe precisely because the caps hash is a **mirror, not a source** —
auth-service owns the truth and Redis is a derived read cache. Deleting a
derived record is a cache invalidation, not data loss. That property was a
deliberate Phase 4 decision and it is what made the repair a one-liner.

---

## What this says about the design

The honest reading: **`agent:<id>:caps` had two writers and no owner.** Phase 4
built it as a mirror of auth-service; the availability toggle later wrote one
field into the same hash. Neither is wrong in isolation, and the invariant
"this hash is either absent or complete" was never written down anywhere — so
nothing enforced it and no test checked it.

The sentinel field makes the invariant explicit and checkable. The alternative
— keeping availability in its own key, e.g. `agent:<id>:available` — would have
prevented it structurally, and is arguably the better design. It was not taken
because the key layout of these hashes is a **documented contract with
assignment-engine**, which reads them directly on the hot path; splitting the
key would mean changing both services and both smoke suites to fix a bug the
sentinel already closes.

That trade is recorded here rather than hidden: the structural fix is cleaner,
the sentinel is smaller and sufficient, and the invariant is now tested either
way.

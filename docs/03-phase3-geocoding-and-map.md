# Phase 3 — geocoding-service, Redis caching, and the map picker

Addresses in, coordinates out — cached in Redis so the same address is never
looked up twice. Plus the React + Leaflet pickup picker that lets a donor place
a pin instead of trusting a typed address.

Node.js + Express + ioredis on **:4003**; frontend on **:5173**.

```bash
docker compose up -d --build geocoding-service
bash scripts/smoke-geocoding.sh            # 24 checks against the running stack
cd services/geocoding-service && npm test  # 30 tests
cd frontend && npm run dev                 # http://localhost:5173
```

**No OpenCage key is needed.** With `OPENCAGE_API_KEY` empty the service uses a
built-in offline geocoder, and the entire stack works end to end. Add a key and
it switches to real worldwide addresses with no code change.

---

## API

All endpoints require a bearer token — every uncached lookup spends real
provider quota, so an open endpoint would be a free way for anyone to drain the
daily allowance.

### `GET /geocode?address=...`

```json
{
  "query": "12 MG Road, Bengaluru",
  "lat": 12.9757, "lng": 77.6068,
  "formatted": "MG Road, Bengaluru, Karnataka 560001, India",
  "confidence": 9,
  "provider": "offline",
  "cached": false
}
```

`404` when the address cannot be resolved. `cached` is exposed deliberately so
the cache is observable from the outside — the smoke test asserts on it.

### `GET /reverse?lat=..&lng=..`

Coordinates → address. This is what the map picker calls when a pin is dragged.

### `GET /stats`

Hits, misses, provider calls, hit rate, and daily quota usage.

---

## Redis as a cache — the concepts

Phase 0 introduced Redis as a running container. This is the first phase that
actually uses it, and caching is the easiest place to see why an in-memory store
earns its keep: an OpenCage call is a network round trip over the public
internet, rate-limited and metered. A Redis lookup is RAM.

### Cache-aside

The standard pattern, and what `cache/geocodeCache.js` implements:

1. look in the cache
2. hit → return it
3. miss → ask the real provider, store the answer, return it

### SETEX — why every entry has a TTL

```js
await redis.setex(key, ttlSeconds, JSON.stringify(value));
```

`SETEX` is "set with an expiry" in one atomic command. The TTL is what stops the
cache growing without bound: entries nobody asks for again simply evaporate.
There is no cleanup job to write, schedule, or debug.

TTLs here are chosen from how fast the underlying truth changes:

| Entry | TTL | Why |
|---|---|---|
| Successful lookup | **30 days** | A street address does not move. A long TTL is what makes the cache pay for itself. |
| "Not found" | **1 hour** | See negative caching below. |

### Key design is most of what makes a cache work

`"12 MG Road, Bengaluru"`, `"12 mg road,  bengaluru"` and
`"12 MG ROAD., BENGALURU"` are the same place. If each produces its own key,
each pays for its own provider call and the hit rate collapses.

So every address is normalized before hashing — lowercased, accent-folded,
punctuation stripped, whitespace collapsed:

```js
'12 MG Road, Bengaluru'  ->  '12 mg road bengaluru'  ->  geo:fwd:<sha1>
```

The key is a **hash**, not the raw address: an arbitrarily long address would
make an arbitrarily long key, and a raw address in a key name needlessly exposes
where someone lives to anything that lists keys.

**Reverse lookups round coordinates to 4 decimal places (~11 m).** This one is
easy to miss and it matters: a dragged map pin emits a slightly different
coordinate on *every pixel of movement*, so without rounding nothing is ever a
cache hit and a single drag fires dozens of provider calls. 11 m is smaller than
a building, so the answer stays correct.

### Negative caching

A typo'd address returns nothing. Without caching that, every retry of the same
typo costs another provider call — so a client in a retry loop can drain a
2500/day quota on an address that will never resolve.

So failures are cached too, as `{ notFound: true }` — but for **1 hour, not 30
days**, because "not found" can become "found" when the provider updates its
data.

### Single-flight — cache stampede protection

Suppose 50 clients request the same uncached address at the same instant. The
naive cache-aside makes **50 identical provider calls** — burning 50 units of
quota to compute one answer, and hammering the provider at exactly the moment it
is most needed.

The fix is to share one in-flight promise: the first request calls the provider,
the other 49 wait for it and receive the same result.

There is a test for this, because it is the kind of thing that looks right and
isn't:

```js
const responses = await Promise.all(
  Array.from({ length: 12 }, () => get('/geocode?address=Koramangala, Bengaluru')),
);
assert.equal(providerCalls, 1);   // not 12
```

### Atomic counters

```js
redis.incr('geo:stats:hits');
```

`INCR` is atomic, so concurrent requests cannot lose a count between them. The
same primitive tracks per-agent load in Phase 4 — and that one is not just a
statistic, it is an input to the scoring formula.

### The daily quota guard

```js
geo:quota:2026-09-20   ->   counter, 48h TTL
```

The counter's **name contains today's date**, so it resets at midnight UTC by
simply being a different key, and yesterday's expires on its own. No scheduled
reset job exists, because none is needed. Exceeding the configured limit returns
`503 QUOTA_EXHAUSTED` rather than getting the API key suspended.

### A cache outage must never become an outage

Every Redis interaction is wrapped so a failure degrades to a miss:

```js
catch (err) {
  logger.warn(...'cache read failed, treating as a miss');
  return null;
}
```

`enableOfflineQueue: false` on the client matters too — without it, commands
queue up forever while Redis is unreachable and requests hang instead of falling
through to the provider. `/ready` reports Redis as down but still returns 200:
a cache outage makes lookups slower and costlier, not *wrong*, so refusing
traffic would turn a performance problem into an availability one.

---

## The provider abstraction

`providers/` holds two implementations behind one interface returning
`{ lat, lng, formatted, confidence, provider }`:

- **`opencage`** — the real API, used when `OPENCAGE_API_KEY` is set.
- **`offline`** — deterministic, no network.

`GEOCODER_PROVIDER=auto` picks between them based on whether a key exists.

The offline provider is **not** a fake that always succeeds. It knows ten real
Bengaluru landmarks with genuine coordinates (so distances between them are
real, which matters once assignment-engine starts ranking agents by proximity),
returns `null` for addresses that should not resolve, gives *lower confidence*
for addresses it had to guess, and derives stable pseudo-coordinates from a hash
of the address so the same input always gives the same point. Cache behaviour can
therefore be exercised honestly without a key.

Confining the third party to one file is the real point: swapping OpenCage for
Mapbox or Nominatim means writing one new provider, not touching controllers,
caches, or the frontend.

---

## Why donation-service calls this over HTTP, not Kafka

This is the first synchronous service-to-service call in the project, and it is
a deliberate exception.

**Kafka is for facts. HTTP is for questions.** "This donation was created" is a
fact — announce it and move on. "Where is this address?" is a question whose
answer is needed before work can continue. Doing that over Kafka would mean
saving the donation, waiting for a reply event, then updating it: far more
machinery for something the donor is already waiting on.

The coupling is bounded deliberately:

- a **5-second timeout**, so a slow third party cannot hold a donor's
  submission open
- any failure — timeout, 404, service down — degrades to *"donation saved
  without coordinates"*, never an error

A donation is a real offer of real food. Rejecting it because an address didn't
resolve would throw away the thing the product exists to capture. The address is
stored either way and can be geocoded later.

It is also skipped entirely when the client already sent coordinates — the map
picker supplies exact ones, and spending a lookup to second-guess them would be
wasted quota.

---

## The map picker

`frontend/src/components/LocationPicker.jsx`, React + Leaflet, with three ways
to set a location because no single one always works:

1. **type an address** → forward geocode
2. **click or drag the pin** → reverse geocode
3. **use my current location** → browser geolocation, then reverse geocode

Whichever route, the parent gets `{ lat, lng, address }`, and those exact
coordinates are submitted with the donation.

Four details worth knowing, all of which are common bugs:

**Leaflet's marker icons must be re-pointed at bundled assets.** The defaults are
relative URLs that break under any bundler — the classic "my map has no marker"
problem.

**The map container needs an explicit height** (`.map { height: 320px }`) or it
collapses to zero and the map is invisible. The single most common react-leaflet
problem.

**Stale-response guarding.** A `requestId` ref means a slow earlier lookup
landing after a newer one cannot overwrite the more recent answer.

**A failed reverse lookup does not discard the coordinates.** The pin position is
already correct and is what actually matters; only the human-readable label is
missing.

The picker also surfaces **confidence**. A vague address resolves to the middle
of a long road, and an agent sent to the wrong end wastes a trip on food that may
not keep — so a low-confidence match says *"rough match, please check the pin"*
rather than pretending to precision it doesn't have.

### The Vite proxy

The browser talks to **one origin** and Vite forwards `/api/auth`,
`/api/donations` and `/api/geo` to ports 4001/4002/4003. Without it the app would
call three ports directly, needing CORS configuration on every service and three
base URLs to keep in sync.

This is also a rehearsal: `api-gateway` in Phase 12 plays exactly this role, so
the frontend's view of the world does not change when it arrives.

---

## Verification

**30 unit tests** + **24 smoke checks** + **6 new donation-service tests** for
the fallback (which stub `fetch`, so they need no running geocoding-service).

Live cache statistics after one smoke run:

```json
{"provider":"offline","cache":{"hits":7,"misses":5,"providerCalls":5,
 "hitRate":58.3,"quota":{"used":5,"limit":2400,"remaining":2395}}}
```

Five provider calls for twelve lookups. In real use — where donors in the same
neighbourhood submit overlapping addresses — the hit rate climbs considerably
higher.

---

## Adding a real OpenCage key

1. Free key (2500 requests/day) from <https://opencagedata.com/>
2. Put it in the root `.env`: `OPENCAGE_API_KEY=...`
3. `docker compose up -d geocoding-service`

`/health` will report `"provider":"opencage"`. Nothing else changes — same
endpoints, same cache, same frontend.

---

## Deliberately not in this phase

- **Autocomplete / typeahead.** One provider call per keystroke is exactly the
  pattern the quota guard exists to prevent. Doing it properly needs debouncing
  and a prefix cache; not worth it for pickup addresses typed once.
- **Batch geocoding** of existing ungeocoded donations. Worth revisiting when
  there is a backlog to justify it.
- **Polygon/area support.** A pickup is a point.

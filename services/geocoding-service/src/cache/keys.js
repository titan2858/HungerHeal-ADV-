import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Cache key design. This is most of what makes a cache work or not work.
//
// "12 MG Road, Bengaluru", "12 mg road,  bengaluru" and "12 MG Road, Bengaluru "
// are the same place, and must produce the same key - otherwise each spelling
// pays for its own OpenCage call and the hit rate collapses.
// ---------------------------------------------------------------------------

export function normalizeAddress(address) {
  return address
    .toLowerCase()
    .normalize('NFKD')            // "Bengalūru" and "Bengaluru" fold together
    .replace(/[\u0300-\u036f]/g, '') // strip the accents NFKD just separated
    .replace(/[.,#;:]/g, ' ')     // punctuation carries no meaning in an address
    .replace(/\s+/g, ' ')         // collapse runs of whitespace
    .trim();
}

// Hashed rather than stored raw, for two reasons: an arbitrarily long address
// would make an arbitrarily long key, and a raw address in a key name is
// needless exposure of where people live in anything that lists keys.
export function forwardKey(address) {
  const digest = createHash('sha1').update(normalizeAddress(address)).digest('hex');
  return `geo:fwd:${digest}`;
}

// Reverse lookups are rounded to 4 decimal places, about 11 metres.
//
// Without rounding, a dragged map pin emits a slightly different coordinate on
// every pixel of movement and NOTHING is ever a cache hit. Rounding is what
// turns a stream of near-identical lookups into one. 11m is comfortably
// smaller than a building, so the answer stays correct.
export function reverseKey(lat, lng) {
  return `geo:rev:${lat.toFixed(4)}:${lng.toFixed(4)}`;
}

// Counters for the /stats endpoint. Plain integers Redis increments atomically.
export const STATS_HITS = 'geo:stats:hits';
export const STATS_MISSES = 'geo:stats:misses';
export const STATS_PROVIDER_CALLS = 'geo:stats:provider_calls';

// Daily quota counter, named by date so it resets naturally at midnight UTC
// and old counters expire on their own.
export function quotaKey(date = new Date()) {
  return `geo:quota:${date.toISOString().slice(0, 10)}`;
}

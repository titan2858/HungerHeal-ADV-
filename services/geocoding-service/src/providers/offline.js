import { createHash } from 'node:crypto';
import { normalizeAddress } from '../cache/keys.js';

// A deterministic, no-network geocoder.
//
// It exists so the whole system - service, cache, donation flow, map picker -
// can be built, tested and demoed before anyone signs up for an OpenCage key,
// and so the test suite never depends on a third party being up or on a quota.
//
// It is NOT a fake that always succeeds: it honours known landmarks, returns
// null for addresses that should not resolve, and produces stable coordinates
// for anything else, so cache behaviour can be exercised honestly.

// A few real Bengaluru landmarks, so a demo shows recognisable places and the
// distances between them are genuine - which matters once assignment-engine
// starts ranking agents by proximity.
const KNOWN_PLACES = [
  { match: 'mg road', lat: 12.9757, lng: 77.6068, formatted: 'MG Road, Bengaluru, Karnataka 560001, India' },
  { match: 'brigade road', lat: 12.9698, lng: 77.6068, formatted: 'Brigade Road, Bengaluru, Karnataka 560001, India' },
  { match: 'church street', lat: 12.9756, lng: 77.6033, formatted: 'Church Street, Bengaluru, Karnataka 560001, India' },
  { match: 'koramangala', lat: 12.9352, lng: 77.6245, formatted: 'Koramangala, Bengaluru, Karnataka 560034, India' },
  { match: 'indiranagar', lat: 12.9784, lng: 77.6408, formatted: 'Indiranagar, Bengaluru, Karnataka 560038, India' },
  { match: 'whitefield', lat: 12.9698, lng: 77.7500, formatted: 'Whitefield, Bengaluru, Karnataka 560066, India' },
  { match: 'jayanagar', lat: 12.9308, lng: 77.5838, formatted: 'Jayanagar, Bengaluru, Karnataka 560011, India' },
  { match: 'electronic city', lat: 12.8452, lng: 77.6602, formatted: 'Electronic City, Bengaluru, Karnataka 560100, India' },
  { match: 'hebbal', lat: 13.0358, lng: 77.5970, formatted: 'Hebbal, Bengaluru, Karnataka 560024, India' },
  { match: 'majestic', lat: 12.9767, lng: 77.5713, formatted: 'Majestic, Bengaluru, Karnataka 560009, India' },
];

// Bengaluru's bounding box, so generated coordinates land somewhere plausible
// rather than in the ocean.
const CITY = { minLat: 12.83, maxLat: 13.14, minLng: 77.46, maxLng: 77.78 };

export const offlineProvider = {
  name: 'offline',

  async geocode(address) {
    const normalized = normalizeAddress(address);

    // Deliberately unresolvable, so "address not found" and negative caching
    // can be tested without relying on a real provider's failures.
    if (normalized.includes('nowhere') || normalized.includes('xxxxx')) return null;

    const known = KNOWN_PLACES.find((p) => normalized.includes(p.match));
    if (known) {
      return {
        lat: known.lat,
        lng: known.lng,
        formatted: known.formatted,
        confidence: 9,
        provider: 'offline',
      };
    }

    // Stable pseudo-coordinates derived from the address itself: the same
    // address always yields the same point, which is what makes cache hits and
    // repeat lookups behave the way they would in production.
    const digest = createHash('sha256').update(normalized).digest();
    const latFraction = digest.readUInt32BE(0) / 0xffffffff;
    const lngFraction = digest.readUInt32BE(4) / 0xffffffff;

    return {
      lat: Number((CITY.minLat + latFraction * (CITY.maxLat - CITY.minLat)).toFixed(6)),
      lng: Number((CITY.minLng + lngFraction * (CITY.maxLng - CITY.minLng)).toFixed(6)),
      formatted: `${address} (approximate, offline geocoder)`,
      // Low on purpose: this is a guess, and anything consuming confidence
      // should treat it as one.
      confidence: 3,
      provider: 'offline',
    };
  },

  async reverse(lat, lng) {
    // Nearest known landmark by straight-line distance. Good enough to make the
    // map picker feel real without a network call.
    let best = null;
    let bestDistance = Infinity;

    for (const place of KNOWN_PLACES) {
      const d = Math.hypot(place.lat - lat, place.lng - lng);
      if (d < bestDistance) {
        bestDistance = d;
        best = place;
      }
    }

    // ~0.045 degrees is roughly 5km; beyond that, claiming the landmark would
    // be a lie, so return coordinates as the address instead.
    const near = bestDistance < 0.045;

    return {
      lat,
      lng,
      formatted: near
        ? `Near ${best.formatted}`
        : `${lat.toFixed(5)}, ${lng.toFixed(5)} (offline geocoder, no nearby landmark)`,
      confidence: near ? 7 : 2,
      provider: 'offline',
    };
  },
};

import { env } from '../config/env.js';

// Wraps the OpenCage Geocoding API.
//
// Every service that talks to a third party should confine it to one file like
// this: the rest of the codebase deals in { lat, lng, formatted, confidence },
// and swapping OpenCage for Mapbox or Nominatim later means writing one new
// provider, not touching controllers, caches or the frontend.

async function callOpenCage(params, signalMs) {
  const url = new URL(env.OPENCAGE_BASE_URL);
  url.searchParams.set('key', env.OPENCAGE_API_KEY);
  url.searchParams.set('limit', '1');
  url.searchParams.set('no_annotations', '1');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // An external HTTP call with no timeout will eventually hang a request
  // thread behind someone else's outage. AbortSignal.timeout caps it.
  const res = await fetch(url, { signal: AbortSignal.timeout(signalMs) });

  if (res.status === 402) {
    const err = new Error('OpenCage quota exceeded');
    err.quotaExhausted = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('OpenCage rejected the API key');
  }
  if (!res.ok) {
    throw new Error(`OpenCage returned HTTP ${res.status}`);
  }

  return res.json();
}

export const opencageProvider = {
  name: 'opencage',

  async geocode(address) {
    const data = await callOpenCage({ q: address }, env.GEOCODER_TIMEOUT_MS);
    const hit = data.results?.[0];
    if (!hit) return null;

    return {
      lat: hit.geometry.lat,
      lng: hit.geometry.lng,
      formatted: hit.formatted,
      // OpenCage reports 1-10, where 10 is a precise building match. Exposed so
      // the frontend can warn a donor that a vague address resolved roughly -
      // a pickup sent to the wrong end of a long road wastes an agent's trip.
      confidence: hit.confidence ?? null,
      provider: 'opencage',
    };
  },

  async reverse(lat, lng) {
    const data = await callOpenCage({ q: `${lat},${lng}` }, env.GEOCODER_TIMEOUT_MS);
    const hit = data.results?.[0];
    if (!hit) return null;

    return {
      lat,
      lng,
      formatted: hit.formatted,
      confidence: hit.confidence ?? null,
      provider: 'opencage',
    };
  },
};

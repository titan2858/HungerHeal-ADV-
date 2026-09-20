import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// A synchronous HTTP call to geocoding-service - the only one in this service.
//
// Why HTTP here and not Kafka: this is a QUESTION ("where is this address?"),
// not a FACT ("this donation was created"). Events are the right shape for
// announcing something that happened; a request/response is the right shape for
// needing an answer before you can continue. Using Kafka for a lookup would
// mean saving the donation, waiting for a reply event, then updating it - far
// more machinery for something the donor is waiting on anyway.
//
// The coupling this introduces is bounded deliberately: a short timeout, and a
// failure degrades to "donation saved without coordinates" instead of an error.
// ---------------------------------------------------------------------------
export async function geocodeAddress(address, { authorization, traceId }, log = logger) {
  if (!env.GEOCODING_ENABLED) return null;

  try {
    const url = new URL('/geocode', env.GEOCODING_URL);
    url.searchParams.set('address', address);

    const res = await fetch(url, {
      headers: {
        // Forwarded, so geocoding-service sees the real caller rather than
        // this service holding a shared machine credential.
        ...(authorization ? { authorization } : {}),
        // Keeps the lookup on the same trace as the donation that caused it.
        'x-trace-id': traceId ?? '',
      },
      // A donor is waiting on this request. Better to save the donation without
      // coordinates than to hold their submission open behind a slow third
      // party - the address is stored either way and can be geocoded later.
      signal: AbortSignal.timeout(env.GEOCODING_TIMEOUT_MS),
    });

    if (res.status === 404) {
      log.warn({ address }, 'address could not be geocoded');
      return null;
    }
    if (!res.ok) {
      log.warn({ status: res.status }, 'geocoding-service returned an error');
      return null;
    }

    const data = await res.json();
    return {
      lat: data.lat,
      lng: data.lng,
      formatted: data.formatted,
      confidence: data.confidence,
      cached: data.cached,
    };
  } catch (err) {
    // Timeout, DNS failure, service down - all the same outcome: proceed
    // without coordinates rather than reject a perfectly good donation.
    log.warn({ err: err.message }, 'geocoding lookup failed, continuing without coordinates');
    return null;
  }
}

import { getProvider, activeProvider } from '../providers/index.js';
import { cachedLookup, getStats } from '../cache/geocodeCache.js';
import { forwardKey, reverseKey } from '../cache/keys.js';
import { ApiError } from '../utils/ApiError.js';

// GET /geocode?address=...
export async function geocode(req, res, next) {
  try {
    const { address } = req.validatedQuery;
    const provider = getProvider();

    const result = await cachedLookup(
      forwardKey(address),
      () => provider.geocode(address),
      req.log,
    );

    if (result.notFound) {
      // 404 rather than 200-with-null: "no such address" is a real answer to a
      // real question, and the client must branch on it either way.
      throw ApiError.notFound(`could not resolve address: ${address}`);
    }

    req.log.info(
      { cached: result.cached, provider: result.provider, confidence: result.confidence },
      'address geocoded',
    );

    res.json({
      query: address,
      lat: result.lat,
      lng: result.lng,
      formatted: result.formatted,
      confidence: result.confidence,
      provider: result.provider,
      // Surfaced so the cache is observable from the outside - the smoke test
      // asserts that the second identical request comes back cached.
      cached: result.cached,
    });
  } catch (err) {
    if (err.quotaExhausted) {
      return next(
        new ApiError(503, 'QUOTA_EXHAUSTED', 'geocoding quota exhausted; try again tomorrow'),
      );
    }
    next(err);
  }
}

// GET /reverse?lat=..&lng=..
// Used by the map picker: a donor drags a pin, and the address updates.
export async function reverse(req, res, next) {
  try {
    const { lat, lng } = req.validatedQuery;
    const provider = getProvider();

    const result = await cachedLookup(
      // Rounded to ~11m inside reverseKey, otherwise a dragged pin never hits
      // the cache even once.
      reverseKey(lat, lng),
      () => provider.reverse(lat, lng),
      req.log,
    );

    if (result.notFound) {
      throw ApiError.notFound(`could not resolve coordinates: ${lat}, ${lng}`);
    }

    res.json({
      query: { lat, lng },
      lat: result.lat ?? lat,
      lng: result.lng ?? lng,
      formatted: result.formatted,
      confidence: result.confidence,
      provider: result.provider,
      cached: result.cached,
    });
  } catch (err) {
    if (err.quotaExhausted) {
      return next(
        new ApiError(503, 'QUOTA_EXHAUSTED', 'geocoding quota exhausted; try again tomorrow'),
      );
    }
    next(err);
  }
}

// GET /stats - how well the cache is doing. Worth having because the entire
// justification for this service is "do not call a paid, rate-limited API
// twice for the same address", and this is the number that proves it.
export async function stats(_req, res, next) {
  try {
    const s = await getStats();
    res.json({
      provider: activeProvider,
      cache: s ?? { note: 'redis unavailable - lookups are running uncached' },
    });
  } catch (err) {
    next(err);
  }
}

const config = require('../config');
const { haversineKm } = require('../utils/geo');

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const CACHE_MAX_ENTRIES = 1000;
// ~4 decimal places is about 11 m, close enough to share a cached route.
const cacheKey = (from, to) =>
  [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((value) => Number(value).toFixed(4))
    .join(',');

const roundKm = (km) => Math.round(km * 10) / 10;

/**
 * Road distance between two points. Uses the Google Routes API when
 * GOOGLE_MAPS_API_KEY is configured, otherwise (or whenever Google fails)
 * estimates road km as straight-line km x roadFactor so checkout never blocks
 * on the maps provider.
 */
class RouteDistanceService {
  #cache = new Map();

  /**
   * @param {{latitude:number, longitude:number}} from
   * @param {{latitude:number, longitude:number}} to
   * @returns {Promise<{distance_km:number, duration_minutes:number|null, source:'google'|'estimate'}>}
   */
  async measure(from, to) {
    const key = cacheKey(from, to);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value = null;
    if (config.maps.googleApiKey) {
      value = await this.#fromGoogle(from, to).catch((error) => {
        console.log(`[maps] Routes API failed, using estimate: ${error.message}`);
        return null;
      });
    }
    if (!value) value = this.#estimate(from, to);

    // Only cache real routes; estimates are free to recompute.
    if (value.source === 'google') {
      if (this.#cache.size >= CACHE_MAX_ENTRIES) {
        this.#cache.delete(this.#cache.keys().next().value);
      }
      this.#cache.set(key, {
        value,
        expiresAt: Date.now() + config.maps.cacheTtlSeconds * 1000,
      });
    }
    return value;
  }

  #estimate(from, to) {
    const straight = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
    return {
      distance_km: roundKm(straight * config.delivery.roadFactor),
      duration_minutes: null,
      source: 'estimate',
    };
  }

  async #fromGoogle(from, to) {
    const point = ({ latitude, longitude }) => ({
      location: { latLng: { latitude: Number(latitude), longitude: Number(longitude) } },
    });

    const response = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.maps.googleApiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: point(from),
        destination: point(to),
        travelMode: config.maps.travelMode,
      }),
      signal: AbortSignal.timeout(config.maps.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const route = (await response.json())?.routes?.[0];
    if (!route || !Number.isFinite(route.distanceMeters)) {
      throw new Error('no route returned');
    }

    const seconds = Number.parseInt(String(route.duration || '').replace(/s$/, ''), 10);
    return {
      distance_km: roundKm(route.distanceMeters / 1000),
      duration_minutes: Number.isFinite(seconds) ? Math.ceil(seconds / 60) : null,
      source: 'google',
    };
  }
}

module.exports = new RouteDistanceService();

const config = require('../config');
const { haversineKm } = require('../utils/geo');
const { runOsrm } = require('../utils/osrmQueue');

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const CACHE_MAX_ENTRIES = 1000;
// ~4 decimal places is about 11 m, close enough to share a cached route. The
// checkout quote and the order placed a moment later hit the same entry, so
// the customer pays exactly the price they were shown.
const cacheKey = (from, to) =>
  [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((value) => Number(value).toFixed(4))
    .join(',');

const roundKm = (km) => Math.round(km * 10) / 10;
const ROAD_SOURCES = ['google', 'osrm'];

/**
 * Road distance between two points, in meters (and km, rounded to 0.1, for
 * the existing screens).
 *
 * Providers (ROUTING_PROVIDER, see config.maps.routingProvider):
 *   auto   - Google Routes API when GOOGLE_MAPS_API_KEY is set, then OSRM
 *            (OpenStreetMap roads; OSRM_URL, public server by default)
 *   google - Google only, osrm - OSRM only, none - no routing service
 * When every provider fails, the straight-line distance x DELIVERY_ROAD_FACTOR
 * is returned with source 'estimate'. Callers that must charge by the real
 * road (per-meter pricing) check `isRoadDistance` and refuse estimates.
 */
class RouteDistanceService {
  #cache = new Map();

  /** True when the distance came from a routing service, not an estimate. */
  isRoadDistance(route) {
    return ROAD_SOURCES.includes(route?.source);
  }

  /**
   * @param {{latitude:number, longitude:number}} from
   * @param {{latitude:number, longitude:number}} to
   * @returns {Promise<{distance_m:number, distance_km:number, duration_minutes:number|null, source:'google'|'osrm'|'estimate'}>}
   */
  async measure(from, to) {
    const key = cacheKey(from, to);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value = null;
    for (const provider of this.#providers()) {
      value = await provider(from, to).catch((error) => {
        console.log(`[maps] ${provider.label} road distance failed: ${error.message}`);
        return null;
      });
      if (value) break;
    }
    if (!value) value = this.#estimate(from, to);

    // Only cache real routes; estimates are free to recompute (and the next
    // request should try the routing service again).
    if (this.isRoadDistance(value)) {
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

  #providers() {
    const google = Object.assign((from, to) => this.#fromGoogle(from, to), { label: 'Google Routes' });
    const osrm = Object.assign((from, to) => this.#fromOsrm(from, to), { label: 'OSRM' });
    switch (config.maps.routingProvider) {
      case 'none':
        return [];
      case 'google':
        return config.maps.googleApiKey ? [google] : [];
      case 'osrm':
        return [osrm];
      default:
        return config.maps.googleApiKey ? [google, osrm] : [osrm];
    }
  }

  #result(meters, seconds, source) {
    const distanceM = Math.max(0, Math.round(meters));
    return {
      distance_m: distanceM,
      distance_km: roundKm(distanceM / 1000),
      duration_minutes: Number.isFinite(seconds) ? Math.ceil(seconds / 60) : null,
      source,
    };
  }

  #estimate(from, to) {
    const straight = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
    const meters = Math.round(straight * config.delivery.roadFactor * 1000);
    return this.#result(meters, NaN, 'estimate');
  }

  async #fromOsrm(from, to) {
    const data = await runOsrm(async () => {
      const url = new URL(
        `/route/v1/driving/${Number(from.longitude)},${Number(from.latitude)};${Number(to.longitude)},${Number(to.latitude)}`,
        config.maps.osrmUrl
      );
      // Distance only: no geometry or turn-by-turn steps.
      url.searchParams.set('overview', 'false');
      url.searchParams.set('steps', 'false');
      const response = await fetch(url, {
        headers: { 'User-Agent': config.maps.geocoderUserAgent },
        signal: AbortSignal.timeout(config.maps.routingTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }, config.maps.osrmMinIntervalMs);

    const route = data?.routes?.[0];
    if (data?.code !== 'Ok' || !route || !Number.isFinite(route.distance)) {
      throw new Error(data?.code || 'no route returned');
    }
    return this.#result(route.distance, Number(route.duration), 'osrm');
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
    return this.#result(route.distanceMeters, seconds, 'google');
  }
}

module.exports = new RouteDistanceService();

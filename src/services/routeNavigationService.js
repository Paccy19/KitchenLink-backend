const config = require('../config');
const { haversineKm } = require('../utils/geo');

const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 60 * 1000;

/**
 * Road route between two points with turn-by-turn steps, for live delivery
 * tracking (customer map) and the delivery worker's navigation view.
 *
 * Uses the Google Routes API when GOOGLE_MAPS_API_KEY is set, otherwise the
 * OSRM routing service (OpenStreetMap roads), and falls back to a straight
 * line so the maps keep working if both are unreachable.
 *
 * Route: {
 *   source: 'google'|'osrm'|'straight',
 *   distance_m, duration_s,
 *   geometry: [[lng, lat], ...],
 *   steps: [{ instruction, name, distance_m, duration_s, maneuver: { type, modifier, location: [lng, lat] } }]
 * }
 */
class RouteNavigationService {
  #cache = new Map();
  // The public OSRM server asks for at most about one request per second.
  #osrmQueue = Promise.resolve();
  #osrmLast = 0;

  async route(from, to) {
    const key = [from.lat, from.lng, to.lat, to.lng].map((n) => Number(n).toFixed(4)).join(',');
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let value = null;
    if (config.maps.googleApiKey) {
      value = await this.#google(from, to).catch((error) => {
        console.log(`[route] Google Routes failed, trying OSRM: ${error.message}`);
        return null;
      });
    }
    if (!value) {
      value = await this.#osrm(from, to).catch((error) => {
        console.log(`[route] OSRM failed, using a straight line: ${error.message}`);
        return null;
      });
    }
    if (!value) return this.#straight(from, to);

    if (this.#cache.size >= CACHE_MAX_ENTRIES) this.#cache.delete(this.#cache.keys().next().value);
    this.#cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /* --------------------------------- OSRM --------------------------------- */

  async #osrm(from, to) {
    const run = this.#osrmQueue.then(async () => {
      const wait = this.#osrmLast + 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#osrmLast = Date.now();
      const url = new URL(
        `/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`,
        config.maps.osrmUrl
      );
      url.searchParams.set('overview', 'full');
      url.searchParams.set('geometries', 'geojson');
      url.searchParams.set('steps', 'true');
      const response = await fetch(url, {
        headers: { 'User-Agent': config.maps.geocoderUserAgent },
        signal: AbortSignal.timeout(config.maps.geocoderTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    this.#osrmQueue = run.catch(() => {});
    const data = await run;
    const route = data?.routes?.[0];
    if (data?.code !== 'Ok' || !route) throw new Error(data?.code || 'no route');

    return {
      source: 'osrm',
      distance_m: Math.round(route.distance),
      duration_s: Math.round(route.duration),
      geometry: route.geometry.coordinates,
      steps: (route.legs?.[0]?.steps || []).map((step) => ({
        instruction: osrmInstruction(step),
        name: step.name || '',
        distance_m: Math.round(step.distance),
        duration_s: Math.round(step.duration),
        maneuver: {
          type: step.maneuver?.type || 'continue',
          modifier: step.maneuver?.modifier || null,
          location: step.maneuver?.location || null,
        },
      })),
    };
  }

  /* -------------------------------- Google -------------------------------- */

  async #google(from, to) {
    const point = ({ lat, lng }) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
    const response = await fetch(GOOGLE_ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.maps.googleApiKey,
        'X-Goog-FieldMask': [
          'routes.distanceMeters',
          'routes.duration',
          'routes.polyline.encodedPolyline',
          'routes.legs.steps.distanceMeters',
          'routes.legs.steps.staticDuration',
          'routes.legs.steps.startLocation',
          'routes.legs.steps.navigationInstruction',
        ].join(','),
      },
      body: JSON.stringify({
        origin: point(from),
        destination: point(to),
        travelMode: config.maps.travelMode,
        polylineQuality: 'HIGH_QUALITY',
        languageCode: 'en',
        units: 'METRIC',
      }),
      signal: AbortSignal.timeout(config.maps.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const route = (await response.json())?.routes?.[0];
    if (!route?.polyline?.encodedPolyline) throw new Error('no route returned');

    const seconds = (value) => Number.parseInt(String(value || '0').replace(/s$/, ''), 10) || 0;
    const steps = (route.legs?.[0]?.steps || []).map((step) => {
      const { type, modifier } = googleManeuver(step.navigationInstruction?.maneuver);
      const start = step.startLocation?.latLng;
      return {
        instruction: step.navigationInstruction?.instructions || 'Continue',
        name: '',
        distance_m: step.distanceMeters || 0,
        duration_s: seconds(step.staticDuration),
        maneuver: { type, modifier, location: start ? [start.longitude, start.latitude] : null },
      };
    });
    const geometry = decodePolyline(route.polyline.encodedPolyline);
    steps.push({
      instruction: 'You have arrived',
      name: '',
      distance_m: 0,
      duration_s: 0,
      maneuver: { type: 'arrive', modifier: null, location: geometry[geometry.length - 1] },
    });
    return {
      source: 'google',
      distance_m: route.distanceMeters || 0,
      duration_s: seconds(route.duration),
      geometry,
      steps,
    };
  }

  /* -------------------------------- fallback ------------------------------- */

  #straight(from, to) {
    const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
    const roadKm = km * config.delivery.roadFactor;
    return {
      source: 'straight',
      distance_m: Math.round(roadKm * 1000),
      // ~20 km/h through town on a motorbike.
      duration_s: Math.round((roadKm / 20) * 3600),
      geometry: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
      steps: [
        {
          instruction: 'You have arrived',
          name: '',
          distance_m: 0,
          duration_s: 0,
          maneuver: { type: 'arrive', modifier: null, location: [to.lng, to.lat] },
        },
      ],
    };
  }
}

/** Plain-English instruction for an OSRM step. */
function osrmInstruction(step) {
  const { type, modifier, exit } = step.maneuver || {};
  const road = step.name ? step.name : 'the road';
  const onto = step.name ? ` onto ${step.name}` : '';
  const turn = modifier === 'uturn' ? 'Make a U-turn' : `Turn ${modifier || 'ahead'}`;
  switch (type) {
    case 'depart':
      return `Head ${modifier ? `${modifier} ` : ''}on ${road}`;
    case 'arrive':
      return 'You have arrived';
    case 'turn':
      return modifier === 'straight' ? `Continue straight${onto}` : `${turn}${onto}`;
    case 'new name':
      return `Continue onto ${road}`;
    case 'continue':
      return modifier && modifier !== 'straight' ? `${turn} to stay on ${road}` : `Continue on ${road}`;
    case 'end of road':
      return `At the end of the road, turn ${modifier || 'ahead'}${onto}`;
    case 'fork':
      return `Keep ${modifier || 'ahead'} at the fork${onto}`;
    case 'merge':
      return `Merge ${modifier || ''}${onto}`.replace(/\s+/g, ' ');
    case 'on ramp':
    case 'off ramp':
      return `Take the ramp ${modifier || ''}${onto}`.replace(/\s+/g, ' ');
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return exit ? `At the roundabout, take exit ${exit}${onto}` : `Go through the roundabout${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    default:
      return modifier ? `${turn}${onto}` : `Continue on ${road}`;
  }
}

/** Google's maneuver codes as OSRM-style type/modifier (for the turn arrow). */
function googleManeuver(code = '') {
  const map = {
    TURN_LEFT: ['turn', 'left'],
    TURN_RIGHT: ['turn', 'right'],
    TURN_SLIGHT_LEFT: ['turn', 'slight left'],
    TURN_SLIGHT_RIGHT: ['turn', 'slight right'],
    TURN_SHARP_LEFT: ['turn', 'sharp left'],
    TURN_SHARP_RIGHT: ['turn', 'sharp right'],
    UTURN_LEFT: ['turn', 'uturn'],
    UTURN_RIGHT: ['turn', 'uturn'],
    STRAIGHT: ['continue', 'straight'],
    RAMP_LEFT: ['on ramp', 'left'],
    RAMP_RIGHT: ['on ramp', 'right'],
    FORK_LEFT: ['fork', 'left'],
    FORK_RIGHT: ['fork', 'right'],
    MERGE: ['merge', null],
    ROUNDABOUT_LEFT: ['roundabout', 'left'],
    ROUNDABOUT_RIGHT: ['roundabout', 'right'],
    DEPART: ['depart', null],
  };
  const [type, modifier] = map[code] || ['continue', null];
  return { type, modifier };
}

/** Google encoded polyline -> [[lng, lat], ...]. */
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng']) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lng += delta;
    }
    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;
}

module.exports = new RouteNavigationService();
module.exports.decodePolyline = decodePolyline;

const config = require('../config');
const ApiError = require('../utils/ApiError');

const GOOGLE_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_PLACE_URL = 'https://places.googleapis.com/v1/places/';
const CACHE_MAX_ENTRIES = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUGGESTION_LIMIT = 6;

/**
 * Place search used when a vendor sets their kitchen location: suggestions
 * while they type an area or street, then the picked place's position, the
 * box to frame on the map and, for areas, the zone outline.
 *
 * Suggestion: { id, name, secondary, kind: 'area'|'street'|'place', lat?, lng?, bounds? }
 * Place:      { id, name, secondary, kind, lat, lng, bounds?, zone? (GeoJSON) }
 * `bounds` is [west, south, east, north].
 */
class PlaceSearchService {
  #cache = new Map();
  // Nominatim allows at most one request per second.
  #nominatimQueue = Promise.resolve();
  #nominatimLast = 0;

  async autocomplete({ q, near }) {
    const text = String(q ?? '').trim();
    if (text.length < 2) return { suggestions: [] };
    if (text.length > 120) {
      throw ApiError.badRequest('q must be at most 120 characters.', { q: 'maximum length is 120' });
    }
    const bias = near || config.maps.geocoderBias;
    const key = `ac|${text.toLowerCase()}|${bias.lat.toFixed(2)},${bias.lng.toFixed(2)}`;

    return this.#cached(key, async () => {
      if (config.maps.googleApiKey) {
        const google = await this.#googleAutocomplete(text, bias).catch((error) => {
          console.log(`[places] Google autocomplete failed, using OpenStreetMap: ${error.message}`);
          return null;
        });
        if (google) return { suggestions: google };
      }
      return { suggestions: await this.#photonAutocomplete(text, bias) };
    });
  }

  async details(id) {
    const value = String(id ?? '');
    if (value.startsWith('osm:')) {
      if (!/^osm:[NWR]\d+$/.test(value)) throw this.#badId();
      return this.#cached(`pl|${value}`, () => this.#nominatimLookup(value.slice(4)));
    }
    if (value.startsWith('google:')) {
      if (!config.maps.googleApiKey || !/^google:[\w-]{10,300}$/.test(value)) throw this.#badId();
      return this.#cached(`pl|${value}`, () => this.#googleDetails(value.slice(7)));
    }
    throw this.#badId();
  }

  /* ------------------------------ OpenStreetMap ------------------------------ */

  async #photonAutocomplete(text, bias) {
    const url = new URL('/api/', config.maps.photonUrl);
    url.searchParams.set('q', text);
    url.searchParams.set('limit', String(SUGGESTION_LIMIT + 2));
    url.searchParams.set('lat', String(bias.lat));
    url.searchParams.set('lon', String(bias.lng));
    url.searchParams.set('zoom', '12');
    url.searchParams.set('location_bias_scale', '0.1');
    url.searchParams.set('bbox', config.maps.geocoderBounds.join(','));

    const data = await this.#getJson(url, 'Photon');
    const seen = new Set();
    return (data?.features ?? [])
      .map((feature) => this.#fromPhoton(feature))
      .filter((item) => {
        if (!item) return false;
        const dedupe = `${item.name}|${item.secondary}`;
        if (seen.has(dedupe)) return false;
        seen.add(dedupe);
        return true;
      })
      .slice(0, SUGGESTION_LIMIT);
  }

  #fromPhoton(feature) {
    const p = feature?.properties ?? {};
    const [lng, lat] = feature?.geometry?.coordinates ?? [];
    if (!p.osm_type || !p.osm_id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const kind = this.#kindOf(p.osm_key, p.type);
    const secondary = [p.street, p.locality, p.district, p.city, p.county]
      .filter((part) => part && part !== p.name)
      .filter((part, index, all) => all.indexOf(part) === index)
      .join(', ');
    // Photon's extent is [west, north, east, south].
    const bounds = Array.isArray(p.extent)
      ? [p.extent[0], p.extent[3], p.extent[2], p.extent[1]]
      : null;
    return {
      id: `osm:${p.osm_type}${p.osm_id}`,
      name: p.name || p.street || 'Unnamed place',
      secondary,
      kind,
      lat,
      lng,
      bounds,
    };
  }

  async #nominatimLookup(osmId) {
    const url = new URL('/lookup', config.maps.nominatimUrl);
    url.searchParams.set('osm_ids', osmId);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('polygon_geojson', '1');
    url.searchParams.set('polygon_threshold', '0.0003');

    const [place] = (await this.#throttledNominatim(() => this.#getJson(url, 'Nominatim'))) ?? [];
    if (!place) throw ApiError.notFound('That place could not be found.', 'PLACE_NOT_FOUND');

    const lat = Number(place.lat);
    const lng = Number(place.lon);
    const [south, north, west, east] = (place.boundingbox ?? []).map(Number);
    const kind = this.#kindOf(place.category, place.addresstype);
    const zone =
      kind === 'area' && ['Polygon', 'MultiPolygon'].includes(place.geojson?.type) ? place.geojson : null;
    const [name, ...rest] = String(place.display_name || '').split(', ');
    return {
      id: `osm:${osmId}`,
      name: place.name || name || 'Unnamed place',
      secondary: rest.filter((part) => part !== 'Rwanda').join(', '),
      kind,
      lat,
      lng,
      bounds: [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null,
      // A street comes back as its line; the map draws it to show the vendor.
      line: kind === 'street' && /LineString/.test(place.geojson?.type || '') ? place.geojson : null,
      zone,
    };
  }

  #throttledNominatim(task) {
    const run = this.#nominatimQueue.then(async () => {
      const wait = this.#nominatimLast + 1100 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#nominatimLast = Date.now();
      return task();
    });
    this.#nominatimQueue = run.catch(() => {});
    return run;
  }

  /** 'area' (suburb, sector, district…), 'street' or another 'place'. */
  #kindOf(key, type) {
    if (key === 'highway') return 'street';
    if (key === 'place' || key === 'boundary') return 'area';
    if (['suburb', 'quarter', 'neighbourhood', 'city_district', 'district', 'city', 'town', 'village', 'locality', 'county', 'state'].includes(type)) {
      return 'area';
    }
    if (type === 'street') return 'street';
    return 'place';
  }

  /* --------------------------------- Google --------------------------------- */

  async #googleAutocomplete(text, bias) {
    const response = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.maps.googleApiKey,
      },
      body: JSON.stringify({
        input: text,
        includedRegionCodes: [config.maps.geocoderCountry],
        locationBias: {
          circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 30000 },
        },
      }),
      signal: AbortSignal.timeout(config.maps.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    return (data.suggestions ?? [])
      .map(({ placePrediction: p }) => p)
      .filter(Boolean)
      .slice(0, SUGGESTION_LIMIT)
      .map((p) => ({
        id: `google:${p.placeId}`,
        name: p.structuredFormat?.mainText?.text || p.text?.text || 'Unnamed place',
        secondary: p.structuredFormat?.secondaryText?.text || '',
        kind: this.#googleKind(p.types),
      }));
  }

  async #googleDetails(placeId) {
    const response = await fetch(GOOGLE_PLACE_URL + encodeURIComponent(placeId), {
      headers: {
        'X-Goog-Api-Key': config.maps.googleApiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,viewport,types',
      },
      signal: AbortSignal.timeout(config.maps.timeoutMs),
    });
    if (response.status === 404) throw ApiError.notFound('That place could not be found.', 'PLACE_NOT_FOUND');
    if (!response.ok) {
      console.log(`[places] Google place details failed: HTTP ${response.status}`);
      throw new ApiError(502, 'PLACE_SEARCH_UNAVAILABLE', 'Place search is unavailable right now. Pick the spot on the map instead.');
    }
    const place = await response.json();
    const { low, high } = place.viewport ?? {};
    return {
      id: `google:${place.id}`,
      name: place.displayName?.text || 'Unnamed place',
      secondary: place.formattedAddress || '',
      kind: this.#googleKind(place.types),
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      bounds: low && high ? [low.longitude, low.latitude, high.longitude, high.latitude] : null,
      line: null,
      zone: null,
    };
  }

  #googleKind(types = []) {
    if (types.includes('route')) return 'street';
    if (types.some((type) => ['sublocality', 'sublocality_level_1', 'neighborhood', 'locality', 'administrative_area_level_2', 'political'].includes(type))) {
      return 'area';
    }
    return 'place';
  }

  /* --------------------------------- shared --------------------------------- */

  async #getJson(url, provider) {
    try {
      // The timeout covers reading the body too, so both stay inside the try.
      const response = await fetch(url, {
        headers: { 'User-Agent': config.maps.geocoderUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.maps.geocoderTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.log(`[places] ${provider} failed: ${error.message}`);
      throw this.#unavailable();
    }
  }

  async #cached(key, load) {
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await load();
    if (this.#cache.size >= CACHE_MAX_ENTRIES) this.#cache.delete(this.#cache.keys().next().value);
    this.#cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  #unavailable() {
    return new ApiError(
      502,
      'PLACE_SEARCH_UNAVAILABLE',
      'Place search is unavailable right now. Pick the spot on the map instead.'
    );
  }

  #badId() {
    return ApiError.badRequest('id is not a valid place id.', { id: 'use an id from the suggestions' });
  }
}

module.exports = new PlaceSearchService();

const config = require('../config');
const ApiError = require('./ApiError');

const toFiniteNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
};

const assertValid = (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.badRequest('lat and lng must be valid numbers.', {
      lat: 'expected a number between -90 and 90',
      lng: 'expected a number between -180 and 180',
    });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw ApiError.badRequest('lat/lng are out of range.', {
      lat: 'expected a number between -90 and 90',
      lng: 'expected a number between -180 and 180',
    });
  }
  return { lat, lng };
};

const hasValue = (value) => value !== undefined && value !== null && value !== '';

function parseOptionalCoords(query = {}) {
  const hasLat = hasValue(query.lat);
  const hasLng = hasValue(query.lng);

  if (!hasLat && !hasLng) return null;
  if (!hasLat || !hasLng) {
    throw ApiError.badRequest('lat and lng must be provided together.', {
      lat: hasLat ? undefined : 'required when lng is provided',
      lng: hasLng ? undefined : 'required when lat is provided',
    });
  }
  return assertValid(toFiniteNumber(query.lat), toFiniteNumber(query.lng));
}

function parseRequiredCoords(query = {}) {
  const coords = parseOptionalCoords(query);
  if (!coords) {
    throw ApiError.badRequest('lat and lng are required for this endpoint.', {
      lat: 'required',
      lng: 'required',
    });
  }
  return coords;
}

function parseRadius(query = {}) {
  if (!hasValue(query.radius)) return config.geo.defaultRadiusKm;
  const radius = toFiniteNumber(query.radius);
  if (!Number.isFinite(radius) || radius <= 0) {
    throw ApiError.badRequest('radius must be a positive number (kilometers).', {
      radius: `expected a number greater than 0 and at most ${config.geo.maxRadiusKm}`,
    });
  }
  if (radius > config.geo.maxRadiusKm) {
    throw ApiError.badRequest(
      `radius must not exceed ${config.geo.maxRadiusKm} km.`,
      { radius: `maximum value is ${config.geo.maxRadiusKm}` }
    );
  }
  return radius;
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function distanceFromCoords(coords, coordinates) {
  if (!coords || !Array.isArray(coordinates)) return null;
  const [lng, lat] = coordinates;
  const km = haversineKm(coords.lat, coords.lng, lat, lng);
  return Math.round(km * 10) / 10;
}

module.exports = {
  parseOptionalCoords,
  parseRequiredCoords,
  parseRadius,
  haversineKm,
  distanceFromCoords,
};

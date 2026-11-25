const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const { haversineKm } = require('../utils/geo');
const { districtByCode, districtFor, publicDistrict } = require('./rwandaDistricts');

/**
 * A kitchen's big-event delivery coverage: WHERE it is willing and able to
 * deliver big-event orders (with its own, rented or third-party vehicles).
 * It never sets the price — the platform does (bigEventDeliverySettingsService).
 *
 *   big_event_enabled  the kitchen delivers big events at all
 *   areas              any mix of
 *                        { kind: 'district', district: 'gasabo' }
 *                        { kind: 'radius', radius_km: 25, latitude?, longitude?, label? }
 *                      (a radius without a centre is measured from the kitchen)
 *
 * A destination is covered when any area contains it. Outside coverage the
 * customer can still request a special delivery the kitchen may decline.
 */
const LIMITS = { areas: 40, radiusKm: [1, 300], label: 60 };

const newId = () => crypto.randomBytes(5).toString('hex');
const AREA_ID = /^[a-z0-9]{4,24}$/;

function parseArea(raw = {}, index) {
  const fail = (message) => {
    throw ApiError.badRequest(`Coverage area ${index + 1}: ${message}`, { [`areas[${index}]`]: message });
  };
  if (!raw || typeof raw !== 'object') fail('expected an object.');
  const id = typeof raw.id === 'string' && AREA_ID.test(raw.id) ? raw.id : newId();
  if (raw.kind === 'district') {
    const district = districtByCode(raw.district);
    if (!district) fail('choose a district from the list.');
    return { id, kind: 'district', district: district.code, label: district.name, latitude: null, longitude: null, radius_km: null };
  }
  if (raw.kind === 'radius') {
    const radius = Number(raw.radius_km);
    const [min, max] = LIMITS.radiusKm;
    if (!Number.isFinite(radius) || radius < min || radius > max) fail(`the distance must be from ${min} to ${max} km.`);
    const hasCentre = raw.latitude != null && raw.latitude !== '' && raw.longitude != null && raw.longitude !== '';
    let latitude = null;
    let longitude = null;
    if (hasCentre) {
      latitude = Number(raw.latitude);
      longitude = Number(raw.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        fail('the centre point is not a valid location.');
      }
    }
    const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, LIMITS.label) : '';
    return {
      id,
      kind: 'radius',
      district: null,
      label: label || (hasCentre ? `Within ${Math.round(radius * 10) / 10} km` : `Within ${Math.round(radius * 10) / 10} km of my kitchen`),
      latitude,
      longitude,
      radius_km: Math.round(radius * 10) / 10,
    };
  }
  return fail("kind must be 'district' or 'radius'.");
}

/** Validates the kitchen's coverage form. */
function parseDeliveryCoverage(body = {}) {
  if (body.big_event_enabled !== undefined && typeof body.big_event_enabled !== 'boolean') {
    throw ApiError.badRequest('big_event_enabled must be true or false.', { big_event_enabled: 'expected a boolean' });
  }
  const rawAreas = Array.isArray(body.areas) ? body.areas : [];
  if (rawAreas.length > LIMITS.areas) {
    throw ApiError.badRequest(`Add at most ${LIMITS.areas} coverage areas.`, { areas: `max ${LIMITS.areas}` });
  }
  const areas = [];
  const seenDistricts = new Set();
  const seenIds = new Set();
  rawAreas.forEach((raw, index) => {
    const area = parseArea(raw, index);
    if (area.kind === 'district') {
      if (seenDistricts.has(area.district)) return; // the same district twice: keep one
      seenDistricts.add(area.district);
    }
    if (seenIds.has(area.id)) area.id = newId();
    seenIds.add(area.id);
    areas.push(area);
  });
  const enabled = body.big_event_enabled === true;
  if (enabled && areas.length === 0) {
    throw ApiError.badRequest('Add at least one place you deliver to before turning big-event delivery on.', { areas: 'required' });
  }
  return { big_event_enabled: enabled, areas };
}

/** The kitchen's stored coverage with defaults filled in. */
function coverageFor(vendor) {
  const own = vendor?.delivery_coverage || {};
  return {
    big_event_enabled: Boolean(own.big_event_enabled),
    areas: (own.areas || []).map(({ id, kind, district, label, latitude, longitude, radius_km }) => ({
      id,
      kind,
      district: district ?? null,
      district_name: district ? districtByCode(district)?.name ?? district : null,
      label: label || '',
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      radius_km: radius_km ?? null,
    })),
    updated_at: own.updated_at ?? null,
  };
}

/**
 * Is (latitude, longitude) inside the kitchen's coverage? Returns
 * { covered, district, matched_area }. Always decided here, on the server.
 */
function checkCoverage(vendor, latitude, longitude) {
  const coverage = coverageFor(vendor);
  const district = districtFor(latitude, longitude);
  const [kitchenLng, kitchenLat] = vendor?.location?.coordinates ?? [];
  let matched = null;
  for (const area of coverage.areas) {
    if (area.kind === 'district' && district && area.district === district.code) {
      matched = area;
      break;
    }
    if (area.kind === 'radius') {
      const centreLat = area.latitude ?? kitchenLat;
      const centreLng = area.longitude ?? kitchenLng;
      if (!Number.isFinite(centreLat) || !Number.isFinite(centreLng)) continue;
      if (haversineKm(centreLat, centreLng, latitude, longitude) <= area.radius_km) {
        matched = area;
        break;
      }
    }
  }
  return {
    big_event_enabled: coverage.big_event_enabled,
    covered: coverage.big_event_enabled && Boolean(matched),
    district: district ? publicDistrict(district) : null,
    matched_area: matched ? { id: matched.id, kind: matched.kind, label: matched.label } : null,
  };
}

/**
 * Coverage for kitchens that already delivered big events before coverage
 * existed (they set their own fee ranges): delivery on, within the farthest
 * distance their ranges named (at least 10 km) of the kitchen, plus the
 * kitchen's own district.
 */
function legacyCoverage(vendor) {
  const ranges = vendor?.event_package?.delivery_fee_ranges || [];
  const farthest = ranges.reduce((km, r) => Math.max(km, r.to_km ?? r.from_km ?? 0), 0);
  const radius = Math.min(LIMITS.radiusKm[1], Math.max(10, farthest));
  const [lng, lat] = vendor?.location?.coordinates ?? [];
  const district = districtFor(lat, lng);
  const areas = [{ id: newId(), kind: 'radius', district: null, label: `Within ${radius} km of my kitchen`, latitude: null, longitude: null, radius_km: radius }];
  if (district) areas.push({ id: newId(), kind: 'district', district: district.code, label: district.name, latitude: null, longitude: null, radius_km: null });
  return { big_event_enabled: true, areas, updated_at: new Date() };
}

module.exports = { parseDeliveryCoverage, coverageFor, checkCoverage, legacyCoverage, COVERAGE_LIMITS: LIMITS };

const config = require('../config');
const ApiError = require('./ApiError');
const { VEHICLE_TYPES, LEGACY_VEHICLE_TYPES } = require('../models/Driver');

const ALLOWED_VEHICLE_TYPES = [...VEHICLE_TYPES, ...LEGACY_VEHICLE_TYPES];

function parseVehicleType(raw) {
  if (raw === undefined || raw === null || raw === '') return 'motorcycle';
  const value = String(raw).trim().toLowerCase();
  if (!ALLOWED_VEHICLE_TYPES.includes(value)) {
    throw ApiError.badRequest('vehicle_type is invalid.', {
      vehicle_type: `expected one of: ${VEHICLE_TYPES.join(', ')}`,
    });
  }
  return value;
}

function parseCoords(body = {}, { field = 'location', required = true } = {}) {
  const lat = Number(body.latitude ?? body.lat);
  const lng = Number(body.longitude ?? body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!required) return null;
    throw ApiError.badRequest(`${field} coordinates are required.`, {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw ApiError.badRequest(`${field} coordinates are out of range.`, {
      latitude: 'expected a number between -90 and 90',
      longitude: 'expected a number between -180 and 180',
    });
  }
  return { lat, lng };
}

function parseBoolean(raw, { field, fallback }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw ApiError.badRequest(`${field} must be a boolean.`, {
    [field]: 'expected true or false',
  });
}

/** Only these statuses may be set through the driver status endpoint. */
const DRIVER_SETTABLE_STATUSES = ['picked_up', 'out_for_delivery', 'delivered'];

function parseDriverStatus(raw) {
  if (!DRIVER_SETTABLE_STATUSES.includes(raw)) {
    throw ApiError.badRequest('status is invalid.', {
      status: `expected one of: ${DRIVER_SETTABLE_STATUSES.join(', ')}`,
    });
  }
  return raw;
}

function parseOtpCode(raw) {
  const code = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (!/^\d{4,6}$/.test(code)) {
    throw ApiError.badRequest('otp_code must be a 4-6 digit number.', {
      otp_code: 'expected 4-6 digits',
    });
  }
  return code;
}

function assertTransition(currentStatus, nextStatus) {
  const allowed = config.delivery.transitions[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    throw ApiError.conflict(
      `Cannot move delivery from "${currentStatus}" to "${nextStatus}".`,
      'INVALID_DELIVERY_TRANSITION'
    );
  }
  return true;
}

module.exports = {
  parseVehicleType,
  parseCoords,
  parseBoolean,
  parseDriverStatus,
  parseOtpCode,
  assertTransition,
  DRIVER_SETTABLE_STATUSES,
  ALLOWED_VEHICLE_TYPES,
};

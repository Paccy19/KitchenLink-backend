const ApiError = require('./ApiError');

/**
 * Standard platform delivery fee by road meters:
 *
 *   fee = base_fee_rwf + distance_m x per_meter_rwf
 *
 * rounded to whole francs and kept between min_fee_rwf and max_fee_rwf
 * (max null = no maximum). E.g. base 300, 1 RWF/m, 2,000 m -> 2,300 RWF.
 */
function perMeterFee(distanceM, settings) {
  const meters = Math.max(0, Math.round(Number(distanceM) || 0));
  const raw = Math.round(settings.base_fee_rwf + meters * settings.per_meter_rwf);
  let fee = Math.max(settings.min_fee_rwf, raw);
  if (settings.max_fee_rwf != null) fee = Math.min(settings.max_fee_rwf, fee);
  return {
    fee_rwf: fee,
    formula_fee_rwf: raw,
    limited_by: fee > raw ? 'minimum' : fee < raw ? 'maximum' : null,
  };
}

const LIMITS = {
  maxBaseFeeRwf: 100000,
  maxPerMeterRwf: 100,
  maxFeeRwf: 100000,
  minAlertPercent: 10,
  maxAlertPercent: 500,
};

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * Validates the admin's per-meter settings. `platformMinFee` is the floor no
 * delivery fee may go below (500 RWF). Returns the cleaned settings.
 */
function parsePerMeterSettings(raw, { platformMinFee }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('per_meter must be an object.', { per_meter: 'expected an object' });
  }
  const fail = (field, message) => {
    throw ApiError.badRequest(message, { [field]: message });
  };
  const wholeRwf = (field, label, min, max) => {
    const value = blank(raw[field]) ? NaN : Number(raw[field]);
    if (!Number.isInteger(value) || value < min || value > max) {
      fail(field, `${label} must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} RWF.`);
    }
    return value;
  };

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    fail('enabled', 'enabled must be true or false.');
  }
  const baseFee = wholeRwf('base_fee_rwf', 'The base fee', 0, LIMITS.maxBaseFeeRwf);

  const perMeter = blank(raw.per_meter_rwf) ? NaN : Number(raw.per_meter_rwf);
  if (!Number.isFinite(perMeter) || perMeter < 0 || perMeter > LIMITS.maxPerMeterRwf) {
    fail('per_meter_rwf', `The price per meter must be from 0 to ${LIMITS.maxPerMeterRwf} RWF.`);
  }
  // Up to 3 decimals (0.001 RWF per meter = 1 RWF per km).
  if (Math.abs(Math.round(perMeter * 1000) - perMeter * 1000) > 1e-6) {
    fail('per_meter_rwf', 'The price per meter can have at most 3 decimals (e.g. 0.25).');
  }

  const minFee = wholeRwf('min_fee_rwf', 'The minimum fee', platformMinFee, LIMITS.maxFeeRwf);
  let maxFee = null;
  if (!blank(raw.max_fee_rwf)) {
    maxFee = wholeRwf('max_fee_rwf', 'The maximum fee', platformMinFee, LIMITS.maxFeeRwf);
    if (maxFee < minFee) fail('max_fee_rwf', 'The maximum fee cannot be below the minimum fee.');
  }

  let alertPercent = 50;
  if (!blank(raw.route_deviation_alert_percent)) {
    alertPercent = Number(raw.route_deviation_alert_percent);
    if (!Number.isInteger(alertPercent) || alertPercent < LIMITS.minAlertPercent || alertPercent > LIMITS.maxAlertPercent) {
      fail(
        'route_deviation_alert_percent',
        `The route alert must be a whole percentage from ${LIMITS.minAlertPercent} to ${LIMITS.maxAlertPercent}.`
      );
    }
  }

  return {
    enabled: raw.enabled === true,
    base_fee_rwf: baseFee,
    per_meter_rwf: perMeter,
    min_fee_rwf: minFee,
    max_fee_rwf: maxFee,
    route_deviation_alert_percent: alertPercent,
  };
}

module.exports = { perMeterFee, parsePerMeterSettings, PER_METER_LIMITS: LIMITS };

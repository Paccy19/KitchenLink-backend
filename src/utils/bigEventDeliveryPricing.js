const ApiError = require('./ApiError');

/**
 * Big-event delivery fee (platform pricing, separate from the standard
 * delivery fee):
 *
 *   formula = starting_fee_rwf + road meters × per_meter_rwf
 *   fee     = max(min_fee_rwf, formula), rounded to whole francs
 *
 * A fee above auto_ceiling_rwf is NOT charged and NOT cut down to the
 * ceiling: `requires_negotiation` is true and `fee_rwf` is null, so the
 * customer and the kitchen agree a price through a special delivery request.
 *
 * E.g. 3,000 + 20,000 m × 0.5 = 13,000 RWF; 3,000 + 90,000 m × 0.5 = 48,000
 * RWF > 40,000 → negotiation.
 */
function bigEventDeliveryFee(distanceM, settings) {
  const meters = Math.max(0, Math.round(Number(distanceM) || 0));
  const formula = Math.round(settings.starting_fee_rwf + meters * settings.per_meter_rwf);
  const fee = Math.max(settings.min_fee_rwf, formula);
  const requiresNegotiation = fee > settings.auto_ceiling_rwf;
  return {
    distance_m: meters,
    formula_fee_rwf: formula,
    // What the platform would charge without the ceiling (shown to explain why).
    calculated_fee_rwf: fee,
    fee_rwf: requiresNegotiation ? null : fee,
    limited_by: fee > formula ? 'minimum' : null,
    requires_negotiation: requiresNegotiation,
  };
}

const LIMITS = {
  maxStartingFeeRwf: 1000000,
  maxPerMeterRwf: 100,
  maxCeilingRwf: 5000000,
  quotationValidityHours: [1, 24 * 14],
};

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/** Validates the admin's big-event delivery settings; returns the cleaned values. */
function parseBigEventDeliverySettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('Big-event delivery settings must be an object.', { big_event: 'expected an object' });
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

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('enabled', 'enabled must be true or false.');

  const startingFee = wholeRwf('starting_fee_rwf', 'The starting fee', 0, LIMITS.maxStartingFeeRwf);

  const perMeter = blank(raw.per_meter_rwf) ? NaN : Number(raw.per_meter_rwf);
  if (!Number.isFinite(perMeter) || perMeter < 0 || perMeter > LIMITS.maxPerMeterRwf) {
    fail('per_meter_rwf', `The price per meter must be from 0 to ${LIMITS.maxPerMeterRwf} RWF.`);
  }
  if (Math.abs(Math.round(perMeter * 1000) - perMeter * 1000) > 1e-6) {
    fail('per_meter_rwf', 'The price per meter can have at most 3 decimals (e.g. 0.25).');
  }

  const minFee = blank(raw.min_fee_rwf) ? startingFee : wholeRwf('min_fee_rwf', 'The minimum fee', 0, LIMITS.maxCeilingRwf);
  const ceiling = wholeRwf('auto_ceiling_rwf', 'The automatic pricing ceiling', 1, LIMITS.maxCeilingRwf);
  if (ceiling < minFee) fail('auto_ceiling_rwf', 'The automatic pricing ceiling cannot be below the minimum fee.');
  if (ceiling < startingFee) fail('auto_ceiling_rwf', 'The automatic pricing ceiling cannot be below the starting fee.');

  const [minHours, maxHours] = LIMITS.quotationValidityHours;
  let validity = 48;
  if (!blank(raw.quotation_validity_hours)) {
    validity = Number(raw.quotation_validity_hours);
    if (!Number.isInteger(validity) || validity < minHours || validity > maxHours) {
      fail('quotation_validity_hours', `Quotations must stay valid for ${minHours} to ${maxHours} hours.`);
    }
  }

  return {
    enabled: raw.enabled !== false,
    starting_fee_rwf: startingFee,
    per_meter_rwf: perMeter,
    min_fee_rwf: minFee,
    auto_ceiling_rwf: ceiling,
    quotation_validity_hours: validity,
  };
}

module.exports = { bigEventDeliveryFee, parseBigEventDeliverySettings, BIG_EVENT_LIMITS: LIMITS };

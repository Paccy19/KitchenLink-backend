const { test } = require('node:test');
const assert = require('node:assert/strict');
const { perMeterFee, parsePerMeterSettings } = require('../../src/utils/perMeterPricing');

const SETTINGS = { base_fee_rwf: 300, per_meter_rwf: 1, min_fee_rwf: 500, max_fee_rwf: null };
const valid = (overrides = {}) => ({
  enabled: true,
  base_fee_rwf: 300,
  per_meter_rwf: 1,
  min_fee_rwf: 500,
  max_fee_rwf: 5000,
  ...overrides,
});
const PLATFORM = { platformMinFee: 500 };

test('per meter: base fee plus every meter of road (300 + 2,000 m x 1 = 2,300 RWF)', () => {
  assert.deepEqual(perMeterFee(2000, SETTINGS), { fee_rwf: 2300, formula_fee_rwf: 2300, limited_by: null });
  // One more meter costs one more franc.
  assert.equal(perMeterFee(2001, SETTINGS).fee_rwf, 2301);
});

test('per meter: the minimum and maximum fee are applied', () => {
  assert.deepEqual(perMeterFee(50, SETTINGS), { fee_rwf: 500, formula_fee_rwf: 350, limited_by: 'minimum' });
  const capped = perMeterFee(10000, { ...SETTINGS, max_fee_rwf: 5000 });
  assert.deepEqual(capped, { fee_rwf: 5000, formula_fee_rwf: 10300, limited_by: 'maximum' });
});

test('per meter: fractional prices round to whole francs', () => {
  // 300 + 1,234 m x 0.25 = 608.5 -> 609
  assert.equal(perMeterFee(1234, { ...SETTINGS, per_meter_rwf: 0.25 }).fee_rwf, 609);
  assert.equal(perMeterFee(-5, SETTINGS).fee_rwf, 500, 'a negative distance counts as 0 m');
});

test('per meter settings: valid values are accepted and cleaned', () => {
  assert.deepEqual(parsePerMeterSettings(valid({ max_fee_rwf: '' }), PLATFORM), {
    enabled: true,
    base_fee_rwf: 300,
    per_meter_rwf: 1,
    min_fee_rwf: 500,
    max_fee_rwf: null,
    route_deviation_alert_percent: 50,
  });
  assert.equal(parsePerMeterSettings(valid({ per_meter_rwf: 1.005 }), PLATFORM).per_meter_rwf, 1.005);
  assert.equal(parsePerMeterSettings(valid({ enabled: undefined }), PLATFORM).enabled, false);
});

test('per meter settings: bad values are refused', () => {
  const bad = [
    valid({ base_fee_rwf: -1 }),
    valid({ base_fee_rwf: 10.5 }),
    valid({ per_meter_rwf: -0.1 }),
    valid({ per_meter_rwf: 0.0001 }), // more than 3 decimals
    valid({ per_meter_rwf: '' }),
    valid({ min_fee_rwf: 100 }), // below the platform minimum of 500 RWF
    valid({ max_fee_rwf: 400 }),
    valid({ min_fee_rwf: 3000, max_fee_rwf: 2000 }),
    valid({ enabled: 'yes' }),
    valid({ route_deviation_alert_percent: 5 }),
  ];
  for (const settings of bad) {
    assert.throws(() => parsePerMeterSettings(settings, PLATFORM), { statusCode: 400 }, JSON.stringify(settings));
  }
  assert.throws(() => parsePerMeterSettings(null, PLATFORM), { statusCode: 400 });
});

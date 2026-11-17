// Starting per-meter prices (before an admin saves any): 500 RWF + 0.3 RWF/m.
// Runs in its own process, so these settings win over any .env file.
process.env.NODE_ENV = 'test';
for (const key of [
  'DELIVERY_PER_METER_BASE_FEE_RWF',
  'DELIVERY_PER_METER_RWF',
  'DELIVERY_PER_METER_MIN_FEE_RWF',
  'DELIVERY_PER_METER_MAX_FEE_RWF',
]) {
  process.env[key] = '';
}
process.env.DELIVERY_PER_METER_ENABLED = 'true';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const deliveryFeeSettingsService = require('../../src/services/deliveryFeeSettingsService');

test('per meter starting price: 500 RWF + 0.3 RWF per meter, in use when enabled', () => {
  const settings = deliveryFeeSettingsService.perMeter();
  assert.equal(settings.enabled, true);
  assert.equal(settings.base_fee_rwf, 500);
  assert.equal(settings.per_meter_rwf, 0.3);
  assert.equal(settings.min_fee_rwf, 500);
  assert.equal(settings.max_fee_rwf, null);
  assert.equal(deliveryFeeSettingsService.current().mode, 'per_meter');

  // 500 + 2,000 m x 0.3 = 1,100 RWF; one more meter adds 0.3 RWF (rounded).
  assert.equal(deliveryFeeSettingsService.perMeterFeeFor(2000).fee_rwf, 1100);
  assert.equal(deliveryFeeSettingsService.perMeterFeeFor(10000).fee_rwf, 3500);
  // Even 0 m costs the starting price.
  assert.equal(deliveryFeeSettingsService.perMeterFeeFor(0).fee_rwf, 500);
});

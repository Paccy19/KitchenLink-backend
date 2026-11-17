const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bigEventDeliveryFee, parseBigEventDeliverySettings } = require('../../src/utils/bigEventDeliveryPricing');
const { parseDeliveryCoverage, checkCoverage, legacyCoverage } = require('../../src/config/deliveryCoverage');
const { districtFor } = require('../../src/config/rwandaDistricts');
const { canTransition, allowedNext } = require('../../src/services/specialDeliveryTransitions');
const { TRANSITIONS, REQUEST_STATUSES } = require('../../src/config/specialDelivery');

const SETTINGS = { starting_fee_rwf: 3000, per_meter_rwf: 0.5, min_fee_rwf: 3000, auto_ceiling_rwf: 40000 };

test('big-event fee: 3,000 RWF starting fee + road meters × the rate', () => {
  const fee = bigEventDeliveryFee(20000, SETTINGS);
  assert.equal(fee.fee_rwf, 13000);
  assert.equal(fee.requires_negotiation, false);
  assert.equal(bigEventDeliveryFee(0, SETTINGS).fee_rwf, 3000, 'the starting fee is charged even next door');
});

test('big-event fee: exactly the ceiling is charged; above it is negotiated, never cut to the ceiling', () => {
  assert.equal(bigEventDeliveryFee(74000, SETTINGS).fee_rwf, 40000);
  const above = bigEventDeliveryFee(90000, SETTINGS);
  assert.equal(above.requires_negotiation, true);
  assert.equal(above.fee_rwf, null, 'no automatic charge above the ceiling');
  assert.equal(above.calculated_fee_rwf, 48000, 'the real calculation is kept, not truncated to 40,000');
});

test('big-event fee: the minimum applies to a low formula', () => {
  const fee = bigEventDeliveryFee(100, { ...SETTINGS, starting_fee_rwf: 0, min_fee_rwf: 2500 });
  assert.equal(fee.fee_rwf, 2500);
  assert.equal(fee.limited_by, 'minimum');
});

test('big-event settings: valid values are cleaned; a ceiling below the minimum is refused', () => {
  const ok = parseBigEventDeliverySettings({ starting_fee_rwf: 3000, per_meter_rwf: '0.75', auto_ceiling_rwf: 40000 });
  assert.equal(ok.min_fee_rwf, 3000, 'minimum defaults to the starting fee');
  assert.equal(ok.per_meter_rwf, 0.75);
  assert.equal(ok.quotation_validity_hours, 48);
  assert.throws(() => parseBigEventDeliverySettings({ starting_fee_rwf: 3000, per_meter_rwf: 1, min_fee_rwf: 5000, auto_ceiling_rwf: 4000 }));
  assert.throws(() => parseBigEventDeliverySettings({ starting_fee_rwf: -1, per_meter_rwf: 1, auto_ceiling_rwf: 4000 }));
  assert.throws(() => parseBigEventDeliverySettings({ starting_fee_rwf: 3000, per_meter_rwf: 0.12345, auto_ceiling_rwf: 40000 }));
});

const KITCHEN = { location: { coordinates: [30.0619, -1.9441] } }; // Kigali centre (Nyarugenge)
const MUSANZE = { lat: -1.5, lng: 29.6 };
const KIMIRONKO = { lat: -1.94, lng: 30.125 };

test('districts: points map to the nearest district centre', () => {
  assert.equal(districtFor(MUSANZE.lat, MUSANZE.lng).code, 'musanze');
  assert.equal(districtFor(-2.6, 29.74).code, 'huye');
  assert.equal(districtFor(NaN, 1), null);
});

test('coverage: a district or a radius from the kitchen covers a destination', () => {
  const coverage = parseDeliveryCoverage({ big_event_enabled: true, areas: [{ kind: 'district', district: 'gasabo' }, { kind: 'radius', radius_km: 5 }] });
  const vendor = { ...KITCHEN, delivery_coverage: coverage };
  assert.equal(checkCoverage(vendor, KIMIRONKO.lat, KIMIRONKO.lng).covered, true);
  assert.equal(checkCoverage(vendor, -1.95, 30.07).matched_area.kind, 'radius');
  const far = checkCoverage(vendor, MUSANZE.lat, MUSANZE.lng);
  assert.equal(far.covered, false);
  assert.equal(far.district.name, 'Musanze');
});

test('coverage: turned off covers nothing; turning on needs an area; bad areas are refused', () => {
  const off = { ...KITCHEN, delivery_coverage: { big_event_enabled: false, areas: [{ id: 'aaaa', kind: 'radius', radius_km: 300 }] } };
  assert.equal(checkCoverage(off, -1.95, 30.07).covered, false);
  assert.throws(() => parseDeliveryCoverage({ big_event_enabled: true, areas: [] }));
  assert.throws(() => parseDeliveryCoverage({ areas: [{ kind: 'district', district: 'atlantis' }] }));
  assert.throws(() => parseDeliveryCoverage({ areas: [{ kind: 'radius', radius_km: 0 }] }));
  const deduped = parseDeliveryCoverage({ areas: [{ kind: 'district', district: 'huye' }, { kind: 'district', district: 'huye' }] });
  assert.equal(deduped.areas.length, 1);
});

test('coverage: kitchens with old fee ranges keep delivering within their farthest range', () => {
  const coverage = legacyCoverage({ ...KITCHEN, event_package: { delivery_fee_ranges: [{ from_km: 0, to_km: 25, fee_rwf: 1 }] } });
  assert.equal(coverage.big_event_enabled, true);
  assert.equal(coverage.areas[0].radius_km, 25);
  assert.equal(coverage.areas[1].district, 'nyarugenge');
});

test('transitions: only the right side may make each move', () => {
  assert.equal(canTransition('pending_vendor_review', 'negotiation_accepted', 'vendor'), true);
  assert.equal(canTransition('pending_vendor_review', 'negotiation_accepted', 'customer'), false);
  assert.equal(canTransition('quotation_submitted', 'quotation_accepted', 'customer'), true);
  assert.equal(canTransition('quotation_submitted', 'quotation_accepted', 'vendor'), false, 'a kitchen cannot accept its own price');
  assert.equal(canTransition('pending_vendor_review', 'quotation_accepted', 'customer'), false);
  assert.equal(canTransition('vendor_declined', 'negotiating', 'vendor'), false, 'declined is final');
  assert.equal(canTransition('quotation_accepted', 'delivery_confirmed', 'customer'), false, 'only payment confirms');
  assert.deepEqual(allowedNext('completed', 'admin'), []);
  for (const from of Object.keys(TRANSITIONS)) {
    assert.ok(REQUEST_STATUSES.includes(from), from);
    for (const to of Object.keys(TRANSITIONS[from])) assert.ok(REQUEST_STATUSES.includes(to), `${from} → ${to}`);
  }
});

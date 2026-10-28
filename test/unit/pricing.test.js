const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDistanceFeeRanges, rangeForDistance } = require('../../src/utils/distanceFeeRanges');
const { depositPlan, parseEventPackage, priceEventOrder, eventPackageFor } = require('../../src/config/eventPackages');

const LIMITS = { minFee: 0, maxFee: 1000000, maxKm: 500 };

test('fee ranges: a valid set is sorted and accepted', () => {
  const ranges = parseDistanceFeeRanges(
    [
      { from_km: 5, to_km: null, fee_rwf: 3000 },
      { from_km: 0, to_km: 5, fee_rwf: 1000 },
    ],
    LIMITS
  );
  assert.deepEqual(ranges.map((r) => r.from_km), [0, 5]);
});

test('fee ranges: gaps, overlaps, a late start and a closed end are refused', () => {
  const bad = [
    [{ from_km: 0, to_km: 3, fee_rwf: 1 }, { from_km: 4, to_km: null, fee_rwf: 1 }],
    [{ from_km: 0, to_km: 5, fee_rwf: 1 }, { from_km: 4, to_km: null, fee_rwf: 1 }],
    [{ from_km: 1, to_km: null, fee_rwf: 1 }],
    [{ from_km: 0, to_km: 5, fee_rwf: 1 }],
    [{ from_km: 0, to_km: null, fee_rwf: 1.5 }],
  ];
  for (const ranges of bad) {
    assert.throws(() => parseDistanceFeeRanges(ranges, LIMITS), undefined, JSON.stringify(ranges));
  }
});

test('fee ranges: a distance on the edge uses the next range', () => {
  const ranges = [
    { from_km: 0, to_km: 5, fee_rwf: 1000 },
    { from_km: 5, to_km: null, fee_rwf: 3000 },
  ];
  assert.equal(rangeForDistance(ranges, 4.9).fee_rwf, 1000);
  assert.equal(rangeForDistance(ranges, 5).fee_rwf, 3000);
  assert.equal(rangeForDistance(ranges, 400).fee_rwf, 3000);
  assert.equal(rangeForDistance([], 3), null);
});

test('deposit: half now, the rest due a day before the event', () => {
  const eventAt = new Date('2026-12-20T15:00:00Z');
  const plan = depositPlan(100001, eventAt);
  assert.equal(plan.deposit_rwf + plan.balance_rwf, 100001, 'no franc lost to rounding');
  assert.equal(plan.deposit_rwf, 50001);
  assert.equal(plan.balance_due_at.toISOString(), '2026-12-19T15:00:00.000Z');
});

const offer = (overrides = {}) =>
  eventPackageFor({
    event_package: parseEventPackage({
      enabled: true,
      packages: [
        {
          id: 'buffet01',
          name: 'Buffet',
          tiers: [
            { min_guests: 10, max_guests: 49, price_per_plate_rwf: 7000 },
            { min_guests: 50, max_guests: 200, price_per_plate_rwf: 5000 },
          ],
          menu: ['Rice'],
        },
      ],
      delivery_fee_ranges: [
        { from_km: 0, to_km: 10, fee_rwf: 5000 },
        { from_km: 10, to_km: null, fee_rwf: 20000 },
      ],
      ...overrides,
    }),
  });

test('event price: guests × the plate price of their range, plus delivery', () => {
  const price = priceEventOrder(offer(), 50, { pickup: false, distanceKm: 12 });
  assert.equal(price.price_per_plate_rwf, 5000);
  assert.equal(price.total_rwf, 50 * 5000 + 20000);

  const pickup = priceEventOrder(offer(), 49, { pickup: true, distanceKm: 12 });
  assert.equal(pickup.total_rwf, 49 * 7000);
});

test('event price: guests no range covers are refused', () => {
  assert.throws(() => priceEventOrder(offer(), 9, { pickup: true }), { code: 'GUESTS_OUT_OF_RANGE' });
  assert.throws(() => priceEventOrder(offer(), 201, { pickup: true }), { code: 'GUESTS_OUT_OF_RANGE' });
});

test('event settings: overlapping guest ranges and big events without a delivery fee are refused', () => {
  assert.throws(() =>
    parseEventPackage({
      enabled: true,
      packages: [
        {
          name: 'Buffet',
          tiers: [
            { min_guests: 10, max_guests: 50, price_per_plate_rwf: 7000 },
            { min_guests: 50, max_guests: 100, price_per_plate_rwf: 5000 },
          ],
          menu: ['Rice'],
        },
      ],
      delivery_fee_ranges: [{ from_km: 0, to_km: null, fee_rwf: 1000 }],
    })
  );
  assert.throws(() =>
    parseEventPackage({
      enabled: true,
      packages: [{ name: 'Buffet', tiers: [{ min_guests: 1, max_guests: 9, price_per_plate_rwf: 1000 }], menu: ['Rice'] }],
      delivery_fee_ranges: [],
    })
  );
});

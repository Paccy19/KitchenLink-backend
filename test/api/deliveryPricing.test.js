// Standard platform delivery fee by road meters: quotes, checkout, stored
// prices, routing failures and route deviation monitoring. Road distances come
// from a local stub of the OSRM routing API (no internet needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// What the stub OSRM server answers: a distance, or an error.
const stub = { distanceM: 2000, fail: false, calls: 0 };
const osrm = http.createServer((req, res) => {
  stub.calls += 1;
  if (stub.fail) {
    res.writeHead(500).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: stub.distanceM, duration: 420 }] }));
});

let h; // test helpers, loaded once the stub's address is known
let kitchen;
let Order;
let Delivery;
let Driver;
let deliveryFeeSettingsService;
let deliveryService;
let adminOperationsService;

// Each test uses its own drop-off point so cached routes never leak between tests.
let pointIndex = 0;
const dropoff = () => {
  pointIndex += 1;
  return { address: `KG ${pointIndex} St, Kigali`, latitude: -1.95 - pointIndex * 0.002, longitude: 30.07 };
};

const PER_METER = { enabled: true, base_fee_rwf: 300, per_meter_rwf: 1, min_fee_rwf: 500, max_fee_rwf: 5000 };

before(async () => {
  await new Promise((resolve) => osrm.listen(0, '127.0.0.1', resolve));
  process.env.ROUTING_PROVIDER = 'osrm';
  process.env.OSRM_URL = `http://127.0.0.1:${osrm.address().port}`;
  process.env.OSRM_MIN_INTERVAL_MS = '0';
  h = require('../helpers/testServer');
  ({ Order, Delivery, Driver } = require('../../src/models'));
  deliveryFeeSettingsService = require('../../src/services/deliveryFeeSettingsService');
  deliveryService = require('../../src/services/deliveryService');
  adminOperationsService = require('../../src/services/adminOperationsService');

  await h.start();
  kitchen = await h.createKitchen({ name: 'Meter Kitchen', dishes: [{ name: 'Isombe', price_rwf: 4000 }] });
  await deliveryFeeSettingsService.update(null, { per_meter: PER_METER });
});
after(async () => {
  await h.stop();
  await new Promise((resolve) => osrm.close(resolve));
});

const quote = (point) =>
  h.api('GET', `/vendors/${kitchen.vendor._id}/delivery-quote?lat=${point.latitude}&lng=${point.longitude}`);

async function customerWithCart() {
  const customer = await h.createCustomer();
  await h.api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id), quantity: 1 } });
  return customer;
}

const checkout = (token, body) => h.api('POST', '/orders/checkout', { token, body: { ...h.MOBILE_MONEY, ...body } });

test('the quote charges base fee + road meters x price per meter, from the routing service', async () => {
  stub.distanceM = 2000;
  const res = await quote(dropoff());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.fulfillment, 'delivery');
  assert.equal(res.body.distance_m, 2000);
  assert.equal(res.body.distance_source, 'osrm');
  assert.equal(res.body.delivery_fee_rwf, 2300);
  assert.equal(res.body.pricing.mode, 'per_meter');
  assert.equal(res.body.pricing.per_meter_rwf, 1);
  assert.equal(res.body.pickup.address, 'KN 1 Ave', 'the pickup point is shown');
});

test('checkout recalculates the fee on the server and ignores fees sent by the customer', async () => {
  stub.distanceM = 2000;
  const { token } = await customerWithCart();
  const res = await checkout(token, {
    delivery_location: dropoff(),
    delivery_fee_rwf: 1,
    pricing: { deliveryFee: 1, total: 1 },
    delivery_pricing: { fee_rwf: 1, distance_m: 1 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.delivery_fee_rwf, 2300);
  assert.equal(res.body.delivery_distance_m, 2000);
  assert.equal(res.body.total_rwf, 4000 + 2300);

  const saved = await Order.findById(res.body.id).lean();
  assert.equal(saved.delivery_pricing.mode, 'per_meter');
  assert.equal(saved.delivery_pricing.distance_m, 2000);
  assert.equal(saved.delivery_pricing.distance_source, 'osrm');
  assert.equal(saved.delivery_pricing.base_fee_rwf, 300);
  assert.equal(saved.delivery_pricing.per_meter_rwf, 1);
  assert.equal(saved.delivery_pricing.fee_rwf, 2300);
  assert.equal(saved.delivery_pricing.dropoff.latitude, saved.delivery_location.latitude);
});

test('new prices only apply to new orders: placed orders keep their fee', async () => {
  stub.distanceM = 2000;
  const { token } = await customerWithCart();
  const placed = await checkout(token, { delivery_location: dropoff() });
  assert.equal(placed.body.delivery_fee_rwf, 2300);

  await deliveryFeeSettingsService.update(null, { per_meter: { ...PER_METER, per_meter_rwf: 1.5 } });
  try {
    const fresh = await quote(dropoff());
    assert.equal(fresh.body.delivery_fee_rwf, 300 + 3000);
    const kept = await Order.findById(placed.body.id).lean();
    assert.equal(kept.delivery_fee_rwf, 2300);
    assert.equal(kept.delivery_pricing.per_meter_rwf, 1);
  } finally {
    await deliveryFeeSettingsService.update(null, { per_meter: PER_METER });
  }
});

test('the maximum fee caps long trips', async () => {
  stub.distanceM = 12000;
  const res = await quote(dropoff());
  assert.equal(res.body.delivery_fee_rwf, 5000);
  assert.equal(res.body.pricing.formula_fee_rwf, 12300);
  assert.equal(res.body.pricing.limited_by, 'maximum');
});

test('when no routing service answers, delivery is refused (no straight-line guess) and pickup still works', async () => {
  stub.fail = true;
  try {
    const point = dropoff();
    const res = await quote(point);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'ROUTE_UNAVAILABLE');

    const { token } = await customerWithCart();
    const before = await Order.countDocuments();
    const failed = await checkout(token, { delivery_location: point });
    assert.equal(failed.status, 503);
    assert.equal(await Order.countDocuments(), before, 'no order is created');

    const pickup = await checkout(token, { fulfillment: 'pickup' });
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    assert.equal(pickup.body.delivery_fee_rwf, 0);
  } finally {
    stub.fail = false;
  }
});

test('with per-meter pricing off, the previous pricing (formula) is used as before', async () => {
  await deliveryFeeSettingsService.update(null, { per_meter: { ...PER_METER, enabled: false } });
  try {
    stub.distanceM = 2000;
    const res = await quote(dropoff());
    assert.equal(res.status, 200);
    assert.equal(res.body.pricing.mode, 'formula');
    // 500 + 200/km x 2 km = 900 (the config formula)
    assert.equal(res.body.delivery_fee_rwf, 900);
  } finally {
    await deliveryFeeSettingsService.update(null, { per_meter: PER_METER });
  }
});

test('admins cannot save prices below the platform minimum', async () => {
  await assert.rejects(
    deliveryFeeSettingsService.update(null, { per_meter: { ...PER_METER, min_fee_rwf: 100 } }),
    { statusCode: 400 }
  );
  assert.equal(deliveryFeeSettingsService.perMeter().min_fee_rwf, 500, 'settings unchanged');
});

test("a long detour by the worker is flagged but never changes the customer's fee or the worker's pay", async () => {
  stub.distanceM = 2000;
  const { token } = await customerWithCart();
  const point = dropoff();
  const placed = await checkout(token, { delivery_location: point });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));

  const order = await Order.findById(placed.body.id).lean();
  const delivery = await deliveryService.ensureDeliveryForOrder(order, { ready: true });
  assert.equal(delivery.approved_distance_m, 2000);
  const driver = await Driver.create({ name: 'Detour Rider', phone: '+250788900001', status: 'busy', is_online: true });
  await Delivery.updateOne({ _id: delivery._id }, { $set: { driver_id: driver._id, status: 'picked_up' } });

  // Ride ~4.4 km (east, 0.01 degree ~ 1.1 km per step) for a 2 km route.
  // Each fix is a few minutes after the last, like a real trip.
  for (let step = 0; step <= 4; step += 1) {
    await Delivery.updateOne(
      { _id: delivery._id, 'route_monitoring.last_point.at': { $ne: null } },
      { $set: { 'route_monitoring.last_point.at': new Date(Date.now() - 5 * 60 * 1000) } }
    );
    await deliveryService.updateLocation(driver, { latitude: -1.9441, longitude: 30.0619 + step * 0.01, accuracy_m: 10 });
  }

  const after = await Delivery.findById(delivery._id).lean();
  assert.ok(after.route_monitoring.tracked_distance_m > 4000, `tracked ${after.route_monitoring.tracked_distance_m} m`);
  assert.ok(after.route_monitoring.deviation_ratio > 2);
  assert.ok(after.route_monitoring.flagged_at, 'the detour is flagged');
  assert.equal(after.delivery_fee_rwf, 2300, 'delivery fee unchanged');
  assert.equal(after.promised_earnings_rwf, delivery.promised_earnings_rwf, 'worker pay unchanged');
  assert.equal((await Order.findById(order._id).lean()).delivery_fee_rwf, 2300, 'order fee unchanged');

  // A poor GPS fix (wifi/cell estimate) adds nothing.
  await deliveryService.updateLocation(driver, { latitude: -1.9, longitude: 30.2, accuracy_m: 900 });
  const unchanged = await Delivery.findById(delivery._id).lean();
  assert.equal(unchanged.route_monitoring.tracked_distance_m, after.route_monitoring.tracked_distance_m);

  // Admins see it in the delivery fee records, and in the detours filter.
  const records = await adminOperationsService.deliveryFeeRecords({});
  const row = records.items.find((item) => item.order_id === String(order._id));
  assert.equal(row.distance_m, 2000);
  assert.equal(row.fee_rwf, 2300);
  assert.equal(row.mode, 'per_meter');
  assert.ok(row.route_monitoring.flagged_at);
  assert.ok(records.summary.orders >= 1);
  const flagged = await adminOperationsService.deliveryFeeRecords({ flagged: 'true' });
  assert.deepEqual(flagged.items.map((item) => item.order_id), [String(order._id)]);
});

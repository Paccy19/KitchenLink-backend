// Big-event orders: package prices, deposits and the platform's big-event
// delivery fee (3,000 RWF + road meters × 0.5 RWF by default). Road distances
// come from a local stub of the OSRM routing API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const stub = { distanceM: 2000 };
const osrm = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: stub.distanceM, duration: 600 }] }));
});

let start;
let stop;
let api;
let createCustomer;
let createKitchen;
let NEARBY_ADDRESS;
let MOBILE_MONEY;

const DAY_MS = 24 * 60 * 60 * 1000;
let caterer;

before(async () => {
  await new Promise((resolve) => osrm.listen(0, '127.0.0.1', resolve));
  process.env.ROUTING_PROVIDER = 'osrm';
  process.env.OSRM_URL = `http://127.0.0.1:${osrm.address().port}`;
  process.env.OSRM_MIN_INTERVAL_MS = '0';
  ({ start, stop, api, createCustomer, createKitchen, NEARBY_ADDRESS, MOBILE_MONEY } = require('../helpers/testServer'));
  await start();
  ({ vendor: caterer } = await createKitchen({
    name: 'Event Caterer',
    event_package: {
      enabled: true,
      packages: [
        {
          id: 'wedding1',
          name: 'Wedding buffet',
          enabled: true,
          tiers: [
            { min_guests: 50, max_guests: 99, price_per_plate_rwf: 6000 },
            { min_guests: 100, max_guests: 300, price_per_plate_rwf: 5000 },
          ],
          menu: ['Rice', 'Chicken', 'Salad'],
        },
        { id: 'lunch001', name: 'Office lunch', enabled: false, tiers: [], menu: [] },
      ],
    },
    delivery_coverage: { big_event_enabled: true, areas: [{ id: 'radius01', kind: 'radius', radius_km: 20 }] },
  }));
});
after(async () => {
  await stop();
  await new Promise((resolve) => osrm.close(resolve));
});

const eventBody = (overrides = {}) => ({
  vendor_id: String(caterer._id),
  package_id: 'wedding1',
  guests: 120,
  fulfillment: 'delivery',
  delivery_location: NEARBY_ADDRESS,
  event_at: new Date(Date.now() + 10 * DAY_MS).toISOString(),
  ...MOBILE_MONEY,
  ...overrides,
});

test('a quote uses the plate price of the guest range plus the platform big-event delivery fee', async () => {
  const res = await api('POST', '/orders/event-quote', { body: eventBody() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { quote } = res.body;
  assert.equal(quote.price_per_plate_rwf, 5000);
  assert.equal(quote.food_total_rwf, 120 * 5000);
  // 3,000 RWF starting fee + 2,000 m × 0.5 RWF.
  assert.equal(quote.delivery_fee_rwf, 4000);
  assert.equal(quote.total_rwf, 600000 + 4000);
  assert.equal(res.body.delivery.status, 'automatic');
  assert.equal(res.body.delivery.in_coverage, true);
  assert.equal(quote.deposit_rwf + quote.balance_rwf, quote.total_rwf);
});

test('a smaller party pays the price of its own range', async () => {
  const res = await api('POST', '/orders/event-quote', { body: eventBody({ guests: 60 }) });
  assert.equal(res.body.quote.price_per_plate_rwf, 6000);
});

test('pick-up pays no delivery fee', async () => {
  const res = await api('POST', '/orders/event-quote', { body: eventBody({ fulfillment: 'pickup', delivery_location: undefined }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.quote.delivery_fee_rwf, 0);
  assert.equal(res.body.quote.total_rwf, 600000);
});

test('guests outside every range, or a package that is off, are refused', async () => {
  const tooFew = await api('POST', '/orders/event-quote', { body: eventBody({ guests: 10 }) });
  assert.equal(tooFew.status, 409);
  assert.equal(tooFew.body.error.code, 'GUESTS_OUT_OF_RANGE');

  const off = await api('POST', '/orders/event-quote', { body: eventBody({ package_id: 'lunch001' }) });
  assert.equal(off.status, 400);
});

test('an event must be booked at least two days ahead', async () => {
  const { token } = await createCustomer();
  const res = await api('POST', '/orders/event-checkout', {
    token,
    body: eventBody({ event_at: new Date(Date.now() + DAY_MS).toISOString() }),
  });
  assert.equal(res.status, 400);
});

test('booking takes half now; the balance gives the handover code', async () => {
  const { token } = await createCustomer();
  const booked = await api('POST', '/orders/event-checkout', { token, body: eventBody() });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));

  const order = booked.body;
  assert.equal(order.total_rwf, 604000);
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.deposit.deposit_rwf, 302000);
  assert.equal(order.deposit.balance_rwf, 302000);
  assert.equal(order.deposit.amount_paid_rwf, 302000);
  assert.equal(order.deposit.can_pay_balance, true);
  assert.equal(order.payment.amount_rwf, 302000, 'only the deposit is charged at booking');

  const paid = await api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.deposit.amount_paid_rwf, 604000);
  assert.equal(paid.body.deposit.amount_due_rwf, 0);
  assert.equal(paid.body.payment.amount_rwf, 302000);

  const twice = await api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'ALREADY_PAID');
});

test('a failed balance payment changes nothing', async () => {
  const { token } = await createCustomer();
  const order = (await api('POST', '/orders/event-checkout', { token, body: eventBody() })).body;
  const res = await api('POST', `/orders/${order.id}/pay-balance`, { token, body: { payment_simulate: 'fail' } });
  assert.equal(res.status, 402);

  const after = await api('GET', `/orders/${order.id}`, { token });
  assert.equal(after.body.deposit.amount_paid_rwf, 302000);
  assert.equal(after.body.deposit.can_pay_balance, true);
});

test('cancelling after the deposit refunds only the deposit', async () => {
  const { token } = await createCustomer();
  const order = (await api('POST', '/orders/event-checkout', { token, body: eventBody() })).body;
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.refund.amount_rwf, 302000);
});

test('cancelling after the balance refunds everything paid', async () => {
  const { token } = await createCustomer();
  const order = (await api('POST', '/orders/event-checkout', { token, body: eventBody() })).body;
  await api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.refund.amount_rwf, 604000);
});

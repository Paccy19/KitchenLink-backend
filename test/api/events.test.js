const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  start,
  stop,
  api,
  createCustomer,
  createKitchen,
  NEARBY_ADDRESS,
  MOBILE_MONEY,
} = require('../helpers/testServer');

const DAY_MS = 24 * 60 * 60 * 1000;
let caterer;

before(async () => {
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
      delivery_fee_ranges: [
        { from_km: 0, to_km: 5, fee_rwf: 10000 },
        { from_km: 5, to_km: null, fee_rwf: 25000 },
      ],
    },
  }));
});
after(stop);

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

test('a quote uses the plate price of the guest range plus the delivery fee', async () => {
  const res = await api('POST', '/orders/event-quote', { body: eventBody() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { quote } = res.body;
  assert.equal(quote.price_per_plate_rwf, 5000);
  assert.equal(quote.food_total_rwf, 120 * 5000);
  assert.equal(quote.delivery_fee_rwf, 10000);
  assert.equal(quote.total_rwf, 600000 + 10000);
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
  assert.equal(order.total_rwf, 610000);
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.deposit.deposit_rwf, 305000);
  assert.equal(order.deposit.balance_rwf, 305000);
  assert.equal(order.deposit.amount_paid_rwf, 305000);
  assert.equal(order.deposit.can_pay_balance, true);
  assert.equal(order.payment.amount_rwf, 305000, 'only the deposit is charged at booking');

  const paid = await api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.deposit.amount_paid_rwf, 610000);
  assert.equal(paid.body.deposit.amount_due_rwf, 0);
  assert.equal(paid.body.payment.amount_rwf, 305000);

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
  assert.equal(after.body.deposit.amount_paid_rwf, 305000);
  assert.equal(after.body.deposit.can_pay_balance, true);
});

test('cancelling after the deposit refunds only the deposit', async () => {
  const { token } = await createCustomer();
  const order = (await api('POST', '/orders/event-checkout', { token, body: eventBody() })).body;
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.refund.amount_rwf, 305000);
});

test('cancelling after the balance refunds everything paid', async () => {
  const { token } = await createCustomer();
  const order = (await api('POST', '/orders/event-checkout', { token, body: eventBody() })).body;
  await api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.refund.amount_rwf, 610000);
});

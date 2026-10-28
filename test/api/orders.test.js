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

let kitchen;

before(async () => {
  await start();
  kitchen = await createKitchen({
    name: 'Order Test Kitchen',
    dishes: [
      { name: 'Brochettes', price_rwf: 3000 },
      { name: 'Fanta', price_rwf: 1000 },
    ],
  });
});
after(stop);

const dish = (index) => String(kitchen.items[index]._id);

/** A signed-in customer with 2 Brochettes and 1 Fanta in the cart (7,000 RWF). */
async function customerWithCart() {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish(0), quantity: 2 } });
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish(1), quantity: 1 } });
  return customer;
}

const checkout = (token, body = {}) =>
  api('POST', '/orders/checkout', { token, body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY, ...body } });

const agentStatus = (orderId, status, key = process.env.AGENT_API_KEY) =>
  api('PATCH', `/orders/agent/orders/${orderId}/status`, { headers: { 'x-agent-key': key }, body: { status } });

test('delivery checkout charges food plus a delivery fee and empties the cart', async () => {
  const { token } = await customerWithCart();
  const res = await checkout(token);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const order = res.body;
  assert.equal(order.status, 'placed');
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.subtotal_rwf, 7000);
  assert.ok(order.delivery_fee_rwf > 0, 'a delivery fee is charged');
  assert.equal(order.total_rwf, order.subtotal_rwf + order.delivery_fee_rwf);
  assert.equal(order.payment.amount_rwf, order.total_rwf);

  const cart = await api('GET', '/cart', { token });
  assert.equal(cart.body.items.length, 0);
});

test('prices come from the menu, not from what the customer sends', async () => {
  const { token } = await customerWithCart();
  const res = await checkout(token, { subtotal_rwf: 1, total_rwf: 1, delivery_fee_rwf: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.body.subtotal_rwf, 7000);
  assert.ok(res.body.total_rwf > 7000);
});

test('pickup orders have no delivery fee', async () => {
  const { token } = await customerWithCart();
  const res = await checkout(token, { fulfillment: 'pickup', delivery_location: undefined });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.delivery_fee_rwf, 0);
  assert.equal(res.body.total_rwf, 7000);
});

test('checking out an empty cart is refused', async () => {
  const { token } = await createCustomer();
  const res = await checkout(token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'CART_EMPTY');
});

test('a failed payment leaves the order unpaid and it can be paid again', async () => {
  const { token } = await customerWithCart();
  const failed = await checkout(token, { payment_simulate: 'fail' });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.payment_status, 'failed');

  const paid = await api('POST', `/orders/${failed.body.id}/pay`, { token, body: {} });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.payment_status, 'paid');

  const twice = await api('POST', `/orders/${failed.body.id}/pay`, { token, body: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'ALREADY_PAID');
});

test('card numbers are never stored in full', async () => {
  const { token } = await customerWithCart();
  const res = await checkout(token, {
    payment_method: 'card',
    payment_details: { card_number: '4242 4242 4242 4242', card_expiry: '12/99' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes('4242424242424242'));
});

test('bad checkout details are refused', async () => {
  const { token } = await customerWithCart();
  const cases = [
    { payment_method: 'cash' },
    { payment_details: { phone: '0721234567' } }, // not a Mobile Money network
    { payment_method: 'card', payment_details: { card_number: '4242424242424241', card_expiry: '12/99' } }, // fails Luhn
    { delivery_location: { address: 'Somewhere', latitude: '', longitude: '' } },
    { delivery_location: { address: 'Paris', latitude: 48.85, longitude: 2.35 } }, // outside Rwanda
  ];
  for (const body of cases) {
    const res = await checkout(token, body);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} gave ${res.status}`);
  }
  // Nothing was ordered: the cart is still full.
  const cart = await api('GET', '/cart', { token });
  assert.equal(cart.body.items.length, 2);
});

test('a closed kitchen takes no orders for now', async () => {
  const closed = await createKitchen({ name: 'Closed Kitchen', is_open: false, dishes: [{ name: 'Rice', price_rwf: 1500 }] });
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: String(closed.items[0]._id) } });
  const res = await checkout(token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VENDOR_CLOSED');
});

test('customers only see their own orders', async () => {
  const owner = await customerWithCart();
  const order = (await checkout(owner.token)).body;
  const stranger = await createCustomer();

  assert.equal((await api('GET', `/orders/${order.id}`, { token: owner.token })).status, 200);
  assert.equal((await api('GET', `/orders/${order.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', `/orders/${order.id}/cancel`, { token: stranger.token, body: {} })).status, 404);

  const list = await api('GET', '/orders', { token: stranger.token });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(order.id));
});

test('cancelling a paid order opens a refund of the full amount', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token)).body;

  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: { reason: 'Changed my mind' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'cancelled');
  assert.ok(res.body.refund, 'a refund is opened');
  assert.equal(res.body.refund.amount_rwf, order.total_rwf);
  assert.equal(res.body.refund.destination.phone, '0788123456');

  const again = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_CANCELLED');

  const refunds = await api('GET', '/orders/refunds', { token });
  assert.equal(refunds.status, 200);
  assert.ok(JSON.stringify(refunds.body).includes(order.id));
});

test('cancelling an unpaid order opens no refund', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token, { payment_simulate: 'fail' })).body;
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.refund, null);
});

test('the status endpoint needs the agent key', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token)).body;
  assert.equal((await agentStatus(order.id, 'confirmed', 'wrong-key')).status, 401);
  assert.equal((await agentStatus(order.id, 'confirmed', '')).status, 401);
});

test('order status only moves forward', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token)).body;

  assert.equal((await agentStatus(order.id, 'confirmed')).status, 200);
  assert.equal((await agentStatus(order.id, 'preparing')).status, 200);

  const back = await agentStatus(order.id, 'confirmed');
  assert.equal(back.status, 400);
  assert.equal(back.body.error.code, 'INVALID_STATUS_TRANSITION');

  // Only the delivery worker's code check completes an order.
  assert.equal((await agentStatus(order.id, 'delivered')).status, 409);
  assert.equal((await agentStatus(order.id, 'eaten')).status, 400);
});

test('a kitchen cancelling a paid order also opens a refund', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token)).body;
  const res = await agentStatus(order.id, 'cancelled');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');

  const refunds = await api('GET', '/orders/refunds', { token });
  assert.ok(JSON.stringify(refunds.body).includes(order.id));
});

test('an order on its way can no longer be cancelled by the customer', async () => {
  const { token } = await customerWithCart();
  const order = (await checkout(token)).body;
  for (const status of ['confirmed', 'preparing', 'ready', 'assigned', 'picked_up']) {
    assert.equal((await agentStatus(order.id, status)).status, 200, status);
  }
  const res = await api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ORDER_NOT_CANCELLABLE');
});

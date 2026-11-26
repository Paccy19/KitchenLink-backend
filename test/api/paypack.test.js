// Real mobile money through Paypack: the prompt goes to the customer's phone,
// and only Paypack's signed report marks the order paid.
process.env.PAYPACK_CLIENT_ID = 'test-client';
process.env.PAYPACK_CLIENT_SECRET = 'test-secret';
process.env.PAYPACK_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.PAYPACK_BASE_URL = 'https://paypack.test/api';

const crypto = require('crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createCustomer, createKitchen, NEARBY_ADDRESS, MOBILE_MONEY } = require('../helpers/testServer');

// Stand-in for Paypack's API; every other request goes out as usual.
const realFetch = global.fetch;
const sent = [];
let status = 'successful';
global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith(process.env.PAYPACK_BASE_URL)) return realFetch(url, options);
  const path = String(url).slice(process.env.PAYPACK_BASE_URL.length);
  const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path === '/auth/agents/authorize') return reply({ access: 'token', expires: Math.floor(Date.now() / 1000) + 3600 });
  if (path === '/transactions/cashin') {
    const body = JSON.parse(options.body);
    sent.push(body);
    return reply({ ref: `ref-${sent.length}`, status: 'pending', amount: body.amount });
  }
  if (path.startsWith('/events/transactions')) return reply({ transactions: [{ data: { status, created_at: new Date().toISOString() } }] });
  return new Response('{}', { status: 404 });
};

let kitchen;
before(async () => {
  await start();
  kitchen = await createKitchen({ name: 'Paypack Kitchen', dishes: [{ name: 'Brochettes', price_rwf: 3000 }] });
});
after(stop);
beforeEach(() => {
  sent.length = 0;
  status = 'successful';
});

async function placeOrder() {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id), quantity: 2 } });
  const res = await api('POST', '/orders/checkout', { token: customer.token, body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: customer.token, order: res.body };
}

const webhook = (payload, secret = process.env.PAYPACK_WEBHOOK_SECRET) =>
  api('POST', '/payments/paypack/webhook', {
    body: payload,
    headers: { 'x-paypack-signature': crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64') },
  });

test('checkout sends the prompt to the phone and waits for Paypack', async () => {
  const { order } = await placeOrder();
  assert.equal(order.payment_status, 'pending');
  assert.deepEqual(sent, [{ amount: order.total_rwf, number: '0788123456' }]);
});

test("Paypack's signed report marks the order paid, once", async () => {
  const { token, order } = await placeOrder();
  const report = { kind: 'CASHIN', data: { ref: 'ref-1', kind: 'CASHIN', status: 'successful' } };

  assert.equal((await webhook(report, 'wrong-secret')).status, 401);
  assert.equal((await api('GET', `/orders/${order.id}`, { token })).body.payment_status, 'pending');

  assert.equal((await webhook(report)).status, 200);
  assert.equal((await webhook(report)).status, 200); // a repeat changes nothing
  const paid = (await api('GET', `/orders/${order.id}`, { token })).body;
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.payment.status, 'successful');
});

test('when the webhook is late, the app asks and Paypack answers', async () => {
  const { token, order } = await placeOrder();
  const checked = await api('POST', `/orders/${order.id}/payment/check`, { token });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.payment_status, 'paid');
});

test('a declined prompt leaves the order unpaid so the customer can try again', async () => {
  status = 'failed';
  const { token, order } = await placeOrder();
  const checked = (await api('POST', `/orders/${order.id}/payment/check`, { token })).body;
  assert.equal(checked.payment_status, 'pending');
  assert.equal(checked.payment.status, 'failed');
});

test('card is refused before any order is created', async () => {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id), quantity: 1 } });
  const res = await api('POST', '/orders/checkout', {
    token: customer.token,
    body: { delivery_location: NEARBY_ADDRESS, payment_method: 'card', payment_details: { card_number: '4242424242424242', card_expiry: '12/30' } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

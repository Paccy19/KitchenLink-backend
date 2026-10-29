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
const chatRepository = require('../../src/repositories/chatRepository');

let kitchen;

before(async () => {
  await start();
  kitchen = await createKitchen({
    name: 'Chat Kitchen',
    phone: '+250788555111',
    dishes: [{ name: 'Brochettes', price_rwf: 3000 }],
  });
});
after(stop);

const kitchenId = () => String(kitchen.vendor._id);

/** A customer who has placed one order with the kitchen; returns { token, order }. */
async function customerWithOrder(body = {}) {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id) } });
  const order = await api('POST', '/orders/checkout', {
    token: customer.token,
    body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY, ...body },
  });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  return { ...customer, order: order.body };
}

test('a customer who never ordered cannot message the kitchen', async () => {
  const { token } = await createCustomer();
  const res = await api('POST', `/chats/with/${kitchenId()}`, { token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NO_ORDER_WITH_VENDOR');
  assert.ok(res.body.error.message);
});

test('after ordering, the customer can open a chat and message the kitchen', async () => {
  const { token } = await customerWithOrder();
  const opened = await api('POST', `/chats/with/${kitchenId()}`, { token });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.conversation.with.id, kitchenId());

  const chatId = opened.body.conversation.id;
  const sent = await api('POST', `/chats/${chatId}/messages`, { token, body: { body: 'Is my order on its way?' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.mine, true);

  // Opening again gives the same conversation, with the message in it.
  const again = await api('POST', `/chats/with/${kitchenId()}`, { token });
  assert.equal(again.body.conversation.id, chatId);
  assert.equal(again.body.messages.length, 1);
});

test('an order whose payment failed still counts as having ordered', async () => {
  const { token } = await customerWithOrder({ payment_simulate: 'fail' });
  assert.equal((await api('POST', `/chats/with/${kitchenId()}`, { token })).status, 200);
});

test('ordering from one kitchen does not unlock messaging another', async () => {
  const other = await createKitchen({ name: 'Other Kitchen', dishes: [] });
  const { token } = await customerWithOrder();
  const res = await api('POST', `/chats/with/${other.vendor._id}`, { token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NO_ORDER_WITH_VENDOR');
});

test('a chat opened before the rule cannot be used without an order', async () => {
  const customer = await createCustomer();
  const old = await chatRepository.findOrCreate(customer.customer.id, kitchen.vendor._id);
  const res = await api('POST', `/chats/${old._id}/messages`, { token: customer.token, body: { body: 'Hello' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NO_ORDER_WITH_VENDOR');
});

test('an unknown kitchen is a 404, not a 403', async () => {
  const { token } = await customerWithOrder();
  const res = await api('POST', '/chats/with/000000000000000000000000', { token });
  assert.equal(res.status, 404);
});

test('orders show the kitchen’s phone number so the customer can call it', async () => {
  const { token, order } = await customerWithOrder();
  assert.equal(order.vendor.phone, '+250788555111');

  const detail = await api('GET', `/orders/${order.id}`, { token });
  assert.equal(detail.body.vendor.phone, '+250788555111');

  const list = await api('GET', '/orders', { token });
  assert.equal(list.body.orders[0].vendor.phone, '+250788555111');
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createCustomer, createKitchen } = require('../helpers/testServer');

let kitchen;
let otherKitchen;

before(async () => {
  await start();
  kitchen = await createKitchen({
    name: 'Chez Maman',
    dishes: [
      { name: 'Brochettes', price_rwf: 3000 },
      { name: 'Isombe', price_rwf: 2000 },
      { name: 'Sold out', price_rwf: 1000, is_available: false },
    ],
  });
  otherKitchen = await createKitchen({ name: 'Other Place', dishes: [{ name: 'Pizza', price_rwf: 8000 }] });
});
after(stop);

const [brochettes, isombe, soldOut] = [0, 1, 2];
const itemId = (index, k = kitchen) => String(k.items[index]._id);

test('adding dishes adds up the subtotal', async () => {
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity: 2 } });
  const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(isombe), quantity: 1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.item_count, 3);
  assert.equal(res.body.subtotal_rwf, 2 * 3000 + 2000);
  assert.equal(res.body.vendor.name, 'Chez Maman');
});

test('adding the same dish again increases its quantity', async () => {
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity: 2 } });
  const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity: 3 } });
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].quantity, 5);
});

test('adding a dish again cannot go over the 99 limit', async () => {
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity: 60 } });
  const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity: 60 } });
  assert.equal(res.status, 400);

  const cart = await api('GET', '/cart', { token });
  assert.equal(cart.body.items[0].quantity, 60);
});

test('quantity must be a whole number from 1 to 99', async () => {
  const { token } = await createCustomer();
  for (const quantity of [0, -1, 1.5, 100, 'abc']) {
    const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes), quantity } });
    assert.equal(res.status, 400, `quantity ${quantity} should be refused`);
  }
});

test('a sold-out dish cannot be added', async () => {
  const { token } = await createCustomer();
  const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(soldOut) } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ITEM_UNAVAILABLE');
});

test('dishes from a second kitchen are refused', async () => {
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes) } });
  const res = await api('POST', '/cart', { token, body: { menu_item_id: itemId(0, otherKitchen) } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CART_VENDOR_CONFLICT');
});

test('an unknown dish id gives a clear error, not a crash', async () => {
  const { token } = await createCustomer();
  for (const id of ['000000000000000000000000', 'not-an-id']) {
    const res = await api('POST', '/cart', { token, body: { menu_item_id: id } });
    assert.equal(res.status, 404, `id ${id}`);
  }
});

test('changing, removing and clearing', async () => {
  const { token } = await createCustomer();
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(brochettes) } });
  await api('POST', '/cart', { token, body: { menu_item_id: itemId(isombe) } });

  let res = await api('PATCH', `/cart/${itemId(brochettes)}`, { token, body: { quantity: 4 } });
  assert.equal(res.body.subtotal_rwf, 4 * 3000 + 2000);

  res = await api('DELETE', `/cart/${itemId(isombe)}`, { token });
  assert.equal(res.body.items.length, 1);

  res = await api('DELETE', '/cart', { token });
  assert.equal(res.body.items.length, 0);
  assert.equal(res.body.subtotal_rwf, 0);
});

test('one customer cannot see another customer’s cart', async () => {
  const first = await createCustomer();
  const second = await createCustomer();
  await api('POST', '/cart', { token: first.token, body: { menu_item_id: itemId(brochettes) } });
  const res = await api('GET', '/cart', { token: second.token });
  assert.equal(res.body.items.length, 0);
});

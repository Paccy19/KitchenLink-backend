process.env.AGENT_API_KEY ||= 'test-agent-key-that-is-long-enough-to-be-secure';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const { Invoice, Order, TableSession } = require('../../src/models');

let kitchen;
let table;
let ownerToken;

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};

before(async () => {
  await start();
  kitchen = await createKitchen({
    name: 'Seat QR Kitchen',
    dishes: [{ name: 'Rice bowl', price_rwf: 3500 }, { name: 'Tea', price_rwf: 1000 }],
  });
  ownerToken = signToken({ sub: String(kitchen.vendor._id), role: 'vendor' });
  table = ok(await api('POST', '/vendor/tables', {
    token: ownerToken,
    body: { label: 'Six Seats', capacity: 3 },
  }), 201);
});

after(stop);

test('seat QR codes create independent sessions and attribute orders to each seat', async () => {
  assert.equal(table.seats.length, 3);
  assert.equal(new Set(table.seats.map((seat) => seat.token)).size, 3);
  assert.ok(table.seats.every((seat) => seat.token !== table.token));

  const firstSeatToken = table.seats[0].token;
  const secondSeatToken = table.seats[1].token;
  const firstMenu = ok(await api('GET', `/tables/${firstSeatToken}`));
  assert.deepEqual(firstMenu.table.seat, { number: 1 });

  const first = ok(await api('POST', `/tables/${firstSeatToken}/session`, {
    body: { guest_name: 'Guest One' },
  }), 201);
  const second = ok(await api('POST', `/tables/${secondSeatToken}/session`, {
    body: { guest_name: 'Guest Two' },
  }), 201);
  assert.equal(first.table_session_id, second.table_session_id);
  assert.notEqual(first.customer_session_id, second.customer_session_id);
  assert.equal(first.seat_number, 1);
  assert.equal(second.seat_number, 2);

  const occupied = await api('POST', `/tables/${firstSeatToken}/session`, { body: {} });
  assert.equal(occupied.status, 409);
  assert.equal(occupied.body.error.code, 'SEAT_SESSION_OCCUPIED');
  const recovered = ok(await api('POST', `/tables/${firstSeatToken}/session`, {
    headers: { 'x-dining-session-key': first.session_key },
    body: {},
  }), 201);
  assert.equal(recovered.customer_session_id, first.customer_session_id);

  const place = (token, key, itemIndex = 0) => api('POST', `/tables/${token}/orders`, {
    headers: { 'x-dining-session-key': key },
    body: { items: [{ menu_item_id: String(kitchen.items[itemIndex]._id), quantity: 1 }] },
  });
  const firstOrder = ok(await place(firstSeatToken, first.session_key), 201);
  const secondOrder = ok(await place(secondSeatToken, second.session_key, 1), 201);
  const savedFirst = await Order.findById(firstOrder.order.id).lean();
  const savedSecond = await Order.findById(secondOrder.order.id).lean();
  assert.equal(savedFirst.table.seat_number, 1);
  assert.equal(savedSecond.table.seat_number, 2);
  assert.equal(String(savedFirst.table_session_id), first.table_session_id);
  assert.equal(String(savedSecond.table_session_id), first.table_session_id);
  assert.equal(String(savedFirst.customer_session_id), first.customer_session_id);
  assert.equal(String(savedSecond.customer_session_id), second.customer_session_id);
  assert.equal(String(savedFirst.invoice_id), String(savedSecond.invoice_id), 'the existing table-wide invoice remains consolidated');
  const invoice = await Invoice.findById(savedFirst.invoice_id).lean();
  assert.deepEqual(invoice.lines.map((line) => line.seat_number), [1, 2]);
  assert.ok(invoice.lines.every((line) => line.customer_session_id));
  const firstView = ok(await api('GET', `/tables/${firstSeatToken}/orders/${firstOrder.order.id}`, {
    headers: { 'x-guest-key': firstOrder.guest_key },
  }));
  assert.deepEqual(firstView.order.bill.lines.map((line) => line.name), ['Rice bowl']);
  const secondView = ok(await api('GET', `/tables/${secondSeatToken}/orders/${secondOrder.order.id}`, {
    headers: { 'x-guest-key': secondOrder.guest_key },
  }));
  assert.deepEqual(secondView.order.bill.lines.map((line) => line.name), ['Tea']);

  const crossSeat = await place(firstSeatToken, second.session_key);
  assert.equal(crossSeat.status, 401);
  assert.equal(crossSeat.body.error.code, 'DINING_SESSION_INVALID');

  const legacyOrder = ok(await api('POST', `/tables/${table.token}/orders`, {
    body: { items: [{ menu_item_id: String(kitchen.items[0]._id), quantity: 1 }] },
  }), 201);
  const [savedLegacy, savedSeat] = await Promise.all([
    Order.findById(legacyOrder.order.id).lean(),
    Order.findById(firstOrder.order.id).lean(),
  ]);
  assert.equal(String(savedLegacy.invoice_id), String(savedSeat.invoice_id));
  const legacyView = ok(await api('GET', `/tables/${table.token}/orders/${legacyOrder.order.id}`, {
    headers: { 'x-guest-key': legacyOrder.guest_key },
  }));
  assert.deepEqual(legacyView.order.bill.lines.map((line) => line.name), ['Rice bowl']);
  assert.equal(legacyView.order.bill.total_rwf, 3500);
  const refreshedSeatView = ok(await api('GET', `/tables/${firstSeatToken}/orders/${firstOrder.order.id}`, {
    headers: { 'x-guest-key': firstOrder.guest_key },
  }));
  assert.equal(refreshedSeatView.order.bill.total_rwf, 3500);
});

test('seat QR rotation preserves active session recovery but stops new sessions from the old code', async () => {
  const seat = table.seats[2];
  const opened = ok(await api('POST', `/tables/${seat.token}/session`, { body: {} }), 201);
  const rotated = ok(await api('POST', `/vendor/tables/${table.id}/seats/3/qr/rotate`, { token: ownerToken }));
  const newSeat = rotated.seats.find((row) => row.seat_number === 3);
  assert.notEqual(newSeat.token, seat.token);

  ok(await api('GET', `/tables/${seat.token}`));
  const recovered = ok(await api('POST', `/tables/${seat.token}/session`, {
    headers: { 'x-dining-session-key': opened.session_key },
    body: {},
  }), 201);
  assert.equal(recovered.customer_session_id, opened.customer_session_id);

  await TableSession.updateOne(
    { _id: opened.table_session_id, 'customer_sessions._id': opened.customer_session_id },
    { $set: { 'customer_sessions.$.expires_at': new Date(Date.now() - 1000) } }
  );
  const replacedCode = await api('POST', `/tables/${seat.token}/session`, { body: {} });
  assert.equal(replacedCode.status, 409);
  assert.equal(replacedCode.body.error.code, 'SEAT_QR_REPLACED');
});

test('expired guest sessions cannot place orders and a vacant seat can be reopened', async () => {
  const otherTable = ok(await api('POST', '/vendor/tables', {
    token: ownerToken,
    body: { label: 'Temporary seat', capacity: 1 },
  }), 201);
  const seat = otherTable.seats[0];
  const opened = ok(await api('POST', `/tables/${seat.token}/session`, { body: {} }), 201);
  await TableSession.updateOne(
    { _id: opened.table_session_id, 'customer_sessions._id': opened.customer_session_id },
    { $set: { 'customer_sessions.$.expires_at': new Date(Date.now() - 1000) } }
  );

  const reopened = ok(await api('POST', `/tables/${seat.token}/session`, { body: {} }), 201);
  assert.notEqual(reopened.customer_session_id, opened.customer_session_id);
  assert.notEqual(reopened.session_key, opened.session_key);
  const oldKey = await api('POST', `/tables/${seat.token}/orders`, {
    headers: { 'x-dining-session-key': opened.session_key },
    body: { items: [{ menu_item_id: String(kitchen.items[0]._id), quantity: 1 }] },
  });
  assert.equal(oldKey.status, 401);
  assert.equal(oldKey.body.error.code, 'DINING_SESSION_INVALID');
});

test('a table session cannot close with active or unpaid orders, then closes its seat sessions when settled', async () => {
  const closeTable = ok(await api('POST', '/vendor/tables', {
    token: ownerToken,
    body: { label: 'Close Test', capacity: 1 },
  }), 201);
  const seatToken = closeTable.seats[0].token;
  const customerSession = ok(await api('POST', `/tables/${seatToken}/session`, { body: {} }), 201);
  const placed = ok(await api('POST', `/tables/${seatToken}/orders`, {
    headers: { 'x-dining-session-key': customerSession.session_key },
    body: { items: [{ menu_item_id: String(kitchen.items[0]._id), quantity: 1 }] },
  }), 201);

  const active = await api('POST', `/vendor/tables/${closeTable.id}/session/close`, { token: ownerToken });
  assert.equal(active.status, 409);
  assert.equal(active.body.error.code, 'TABLE_SESSION_HAS_ACTIVE_ORDERS');

  await Order.updateOne({ _id: placed.order.id }, { $set: { status: 'completed' } });
  const unpaid = await api('POST', `/vendor/tables/${closeTable.id}/session/close`, { token: ownerToken });
  assert.equal(unpaid.status, 409);
  assert.equal(unpaid.body.error.code, 'TABLE_SESSION_HAS_UNPAID_ORDERS');

  const order = await Order.findById(placed.order.id).lean();
  ok(await api('POST', `/vendor/invoices/${order.invoice_id}/payments`, {
    token: ownerToken,
    body: { amount_rwf: order.total_rwf, method: 'cash', idempotency_key: 'close-session-payment-01' },
  }));
  const result = ok(await api('POST', `/vendor/tables/${closeTable.id}/session/close`, { token: ownerToken }));
  assert.equal(result.status, 'closed');
  assert.equal(result.already_closed, false);

  const savedSession = await TableSession.findById(customerSession.table_session_id).lean();
  assert.equal(savedSession.status, 'closed');
  assert.equal(savedSession.customer_sessions[0].status, 'closed');
  const closedOrder = await api('POST', `/tables/${seatToken}/orders`, {
    headers: { 'x-dining-session-key': customerSession.session_key },
    body: { items: [{ menu_item_id: String(kitchen.items[0]._id), quantity: 1 }] },
  });
  assert.equal(closedOrder.status, 401);
});

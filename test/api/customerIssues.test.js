// The kitchen tells the customer when a dish runs late or can't be made, and
// the customer chooses what happens; orders nobody accepts are escalated.
process.env.AGENT_API_KEY ||= 'test-agent-key-that-is-long-enough-to-be-secure';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen, createCustomer, NEARBY_ADDRESS, MOBILE_MONEY } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const { Order, Refund } = require('../../src/models');
const platformLedgerService = require('../../src/services/platformLedgerService');
const newOrderWatch = require('../../src/services/kitchen/newOrderWatchService');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};
const unreconciled = async () => (await platformLedgerService.snapshot()).unreconciled_rwf;

let K;
let owner;
const dish = {};
let table;

before(async () => {
  await start();
  K = await createKitchen({ name: 'Issue Kitchen' });
  owner = signToken({ sub: String(K.vendor._id), role: 'vendor' });
  for (const [key, name, price] of [['pilau', 'Pilau', 4000], ['cake', 'Cake', 2500], ['coffee', 'Coffee', 1500]]) {
    dish[key] = ok(await api('POST', '/vendor/menu', { token: owner, body: { name, price_rwf: price } }), 201).id;
  }
  ok(await api('POST', '/vendor/departments/setup', {
    token: owner,
    body: { departments: ['restaurant', 'bakery'], dishes: [{ menu_item_id: dish.pilau, category: 'restaurant' }, { menu_item_id: dish.cake, category: 'bakery' }, { menu_item_id: dish.coffee, category: 'restaurant' }] },
  }));
  table = ok(await api('POST', '/vendor/tables', { token: owner, body: { label: 'Table 7' } }), 201);
});
after(stop);

const ticketOf = async (orderId, name) => {
  const { tickets } = ok(await api('GET', '/vendor/kitchen/queue', { token: owner }));
  return tickets.find((t) => t.order.id === orderId && t.items.some((i) => i.name === name));
};
const titles = async () => ok(await api('GET', '/vendor/inbox', { token: owner })).items.map((n) => n.title);

test('a guest at a table hears about a delay, and removes a dish the kitchen cannot make', async () => {
  const placed = ok(await api('POST', `/tables/${table.token}/orders`, {
    body: { items: [{ menu_item_id: dish.pilau, quantity: 1 }, { menu_item_id: dish.cake, quantity: 2 }] },
  }), 201);
  const orderId = placed.order.id;
  const guest = { 'x-guest-key': placed.guest_key };
  const view = async () => ok(await api('GET', `/tables/${table.token}/orders/${orderId}`, { headers: guest })).order;

  // The Kitchen runs late: the guest is told how long, with nothing to answer.
  const kitchenTicket = await ticketOf(orderId, 'Pilau');
  assert.equal((await api('POST', `/vendor/kitchen/orders/${orderId}/tickets/${kitchenTicket.id}/flags`, { token: owner, body: { kind: 'delayed', minutes: 500 } })).status, 400);
  ok(await api('POST', `/vendor/kitchen/orders/${orderId}/tickets/${kitchenTicket.id}/flags`, { token: owner, body: { kind: 'delayed', minutes: 10 } }), 201);
  let order = await view();
  assert.equal(order.issues.length, 1);
  assert.equal(order.issues[0].message, 'Kitchen is running about 10 minutes late.');
  assert.deepEqual(order.issues[0].choices, []);

  // The Bakery is out of cake: the guest may remove it or choose something else.
  const bakeryTicket = await ticketOf(orderId, 'Cake');
  ok(await api('POST', `/vendor/kitchen/orders/${orderId}/tickets/${bakeryTicket.id}/flags`, { token: owner, body: { kind: 'unavailable' } }), 201);
  order = await view();
  const issue = order.issues.find((i) => i.kind === 'unavailable');
  assert.equal(issue.message, "Sorry, we can't make 2× Cake today.");
  assert.deepEqual(issue.choices.map((c) => c.id), ['remove', 'swap']);
  assert.equal(order.bill.total_rwf, 4000 + 5000);

  // A wrong key or a choice that isn't offered is refused.
  assert.equal((await api('POST', `/tables/${table.token}/orders/${orderId}/issues/${issue.id}/respond`, { headers: { 'x-guest-key': 'nope' }, body: { choice: 'remove' } })).status, 404);
  assert.equal((await api('POST', `/tables/${table.token}/orders/${orderId}/issues/${issue.id}/respond`, { headers: guest, body: { choice: 'cancel' } })).status, 409);

  order = ok(await api('POST', `/tables/${table.token}/orders/${orderId}/issues/${issue.id}/respond`, { headers: guest, body: { choice: 'remove' } })).order;
  const answered = order.issues.find((i) => i.id === issue.id);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.choice_label, 'Continue without it');
  assert.deepEqual(answered.choices, []);
  assert.equal(order.bill.total_rwf, 4000, 'the bill went down by the cake');
  assert.equal(order.items.find((i) => i.name === 'Cake').service_status, 'cancelled');
  assert.ok((await titles()).some((t) => t === 'Table 7: continue without Cake'));
  // The bakery's ticket is done with; the kitchen's flag for it is sorted out.
  const fresh = await Order.findById(orderId).lean();
  assert.equal(fresh.tickets.find((t) => String(t._id) === bakeryTicket.id).status, 'cancelled');
  assert.ok(fresh.tickets.find((t) => String(t._id) === bakeryTicket.id).flags[0].resolved_at);
  // Answering twice is refused.
  assert.equal((await api('POST', `/tables/${table.token}/orders/${orderId}/issues/${issue.id}/respond`, { headers: guest, body: { choice: 'remove' } })).status, 409);
});

test('when every dish is missing, the guest can choose something else or cancel', async () => {
  const placed = ok(await api('POST', `/tables/${table.token}/orders`, { body: { items: [{ menu_item_id: dish.cake, quantity: 1 }] } }), 201);
  const orderId = placed.order.id;
  const guest = { 'x-guest-key': placed.guest_key };
  const ticket = await ticketOf(orderId, 'Cake');
  ok(await api('POST', `/vendor/kitchen/orders/${orderId}/tickets/${ticket.id}/flags`, { token: owner, body: { kind: 'unavailable' } }), 201);
  const order = ok(await api('GET', `/tables/${table.token}/orders/${orderId}`, { headers: guest })).order;
  const issue = order.issues.find((i) => i.kind === 'unavailable');
  assert.deepEqual(issue.choices.map((c) => c.id), ['swap', 'cancel']);
  const after = ok(await api('POST', `/tables/${table.token}/orders/${orderId}/issues/${issue.id}/respond`, { headers: guest, body: { choice: 'swap' } })).order;
  assert.equal(after.status, 'cancelled', 'nothing left: the order is cancelled, the guest orders something else');
});

test('an app customer continues without a dish and gets its price back; the books stay balanced', async () => {
  const before = await unreconciled();
  const customer = await createCustomer();
  ok(await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.pilau, quantity: 1 } }));
  ok(await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.cake, quantity: 1 } }));
  const paid = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY } }));
  assert.equal(paid.payment_status, 'paid');
  const total = paid.total_rwf;

  const ticket = await ticketOf(paid.id, 'Cake');
  ok(await api('POST', `/vendor/kitchen/orders/${paid.id}/tickets/${ticket.id}/flags`, { token: owner, body: { kind: 'unavailable', note: 'Sold out' } }), 201);
  let detail = ok(await api('GET', `/orders/${paid.id}`, { token: customer.token }));
  const issue = detail.issues.find((i) => i.kind === 'unavailable');
  assert.deepEqual(issue.choices.map((c) => c.id), ['remove', 'cancel']);
  assert.equal(issue.note, 'Sold out');
  // Someone else can't answer for them.
  const stranger = await createCustomer();
  assert.equal((await api('POST', `/orders/${paid.id}/issues/${issue.id}/respond`, { token: stranger.token, body: { choice: 'remove' } })).status, 404);

  detail = ok(await api('POST', `/orders/${paid.id}/issues/${issue.id}/respond`, { token: customer.token, body: { choice: 'remove' } }));
  assert.equal(detail.issues.find((i) => i.id === issue.id).refund_rwf, 2500);
  assert.equal(detail.total_rwf, total - 2500);
  const refund = await Refund.findOne({ order_id: paid.id, kind: 'item_unavailable' }).lean();
  assert.equal(refund.amount_rwf, 2500);
  const order = await Order.findById(paid.id).lean();
  assert.equal(order.amount_paid_rwf, total, 'what was paid is kept');
  assert.equal(order.subtotal_rwf, 4000);
  assert.equal(await unreconciled(), before, 'no money appears or disappears');

  // Cancelling afterwards refunds only the rest.
  ok(await api('POST', `/orders/${paid.id}/cancel`, { token: customer.token, body: { reason: 'Changed my mind' } }));
  const cancelRefund = await Refund.findOne({ order_id: paid.id, kind: 'order_cancelled' }).lean();
  assert.equal(cancelRefund.amount_rwf, total - 2500);
  assert.equal(await unreconciled(), before);
});

test('an app customer whose only dish is missing can cancel for a full refund', async () => {
  const customer = await createCustomer();
  ok(await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.cake, quantity: 1 } }));
  const paid = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY } }));
  const ticket = await ticketOf(paid.id, 'Cake');
  ok(await api('POST', `/vendor/kitchen/orders/${paid.id}/tickets/${ticket.id}/flags`, { token: owner, body: { kind: 'unavailable' } }), 201);
  const issue = ok(await api('GET', `/orders/${paid.id}`, { token: customer.token })).issues.find((i) => i.kind === 'unavailable');
  assert.deepEqual(issue.choices.map((c) => c.id), ['cancel']);
  const detail = ok(await api('POST', `/orders/${paid.id}/issues/${issue.id}/respond`, { token: customer.token, body: { choice: 'cancel' } }));
  assert.equal(detail.status, 'cancelled');
  assert.equal((await Refund.findOne({ order_id: paid.id, kind: 'order_cancelled' }).lean()).amount_rwf, paid.total_rwf);
});

test('an order nobody accepts rings on the dashboard and is escalated once after 5 minutes', async () => {
  const placed = ok(await api('POST', `/tables/${table.token}/orders`, { body: { items: [{ menu_item_id: dish.pilau, quantity: 1 }] } }), 201);
  const ws = ok(await api('GET', '/vendor/workspace', { token: owner }));
  assert.ok(ws.counts.new_work >= 1, 'new work the dashboard rings for');

  const created = (await Order.findById(placed.order.id).lean()).created_at;
  await newOrderWatch.sweep(new Date(created.getTime() + 3 * 60 * 1000));
  assert.equal((await Order.findById(placed.order.id).lean()).escalated_at, null, 'not before 5 minutes');
  await newOrderWatch.sweep(new Date(created.getTime() + 6 * 60 * 1000));
  assert.ok((await Order.findById(placed.order.id).lean()).escalated_at);
  const warned = (await titles()).filter((t) => t === `Waiting 6 min: ${placed.order.order_number}`);
  assert.equal(warned.length, 1);
  await newOrderWatch.sweep(new Date(created.getTime() + 9 * 60 * 1000));
  assert.equal((await titles()).filter((t) => t.endsWith(placed.order.order_number) && t.startsWith('Waiting')).length, 1, 'warned once');

  // Once a department accepts its ticket, it no longer counts as new work.
  const ticket = await ticketOf(placed.order.id, 'Pilau');
  const beforeCount = ok(await api('GET', '/vendor/workspace', { token: owner })).counts.new_work;
  ok(await api('PATCH', `/vendor/kitchen/orders/${placed.order.id}/tickets/${ticket.id}`, { token: owner, body: { status: 'accepted' } }));
  assert.equal(ok(await api('GET', '/vendor/workspace', { token: owner })).counts.new_work, beforeCount - 1);

  // The kitchen can change the limit, or turn it off.
  assert.equal(ok(await api('PUT', '/vendor/operations', { token: owner, body: { escalate_after_minutes: 0 } })).escalate_after_minutes, 0);
  assert.equal((await api('PUT', '/vendor/operations', { token: owner, body: { escalate_after_minutes: 99 } })).status, 400);
});

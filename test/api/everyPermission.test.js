// Every permission does what it says, in practice: for every kitchen route
// and every permission it accepts, an employee holding ONLY that permission
// gets past the permission checks (route and service) with real records.
// A 403 anywhere means a permission that is granted but doesn't work.
// Then the default roles do their everyday jobs end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, baseUrl, createKitchen, createCustomer } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const access = require('../../src/config/kitchenAccess');
const { Order, Invoice } = require('../../src/models');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};
const tokenFor = (vendor, staffId) => signToken({ sub: String(vendor._id), role: 'vendor', ...(staffId ? { staff_id: String(staffId) } : {}) });

let K;
let owner;
const ids = {};
const solo = new Map();
let phone = 0;

async function employeeWith(permissions, name) {
  phone += 1;
  const role = ok(await api('POST', '/vendor/roles', { token: owner, body: { name: `${name} ${phone}`, permissions } }), 201);
  const staff = ok(await api('POST', '/vendor/staff', { token: owner, body: { name, phone: `0789${String(phone).padStart(6, '0')}`, role_ids: [role.id] } }), 201);
  return { id: staff.id, token: tokenFor(K.vendor, staff.id) };
}

/** An employee holding exactly one permission (made once, reused). */
async function only(permission) {
  if (!solo.has(permission)) solo.set(permission, await employeeWith([permission], `Only ${permission}`));
  return solo.get(permission).token;
}

before(async () => {
  await start();
  K = await createKitchen({ name: 'Permission Kitchen' });
  owner = tokenFor(K.vendor);
  ids.department_id = ok(await api('POST', '/vendor/departments', { token: owner, body: { name: 'Grill', category: 'restaurant' } }), 201).id;
  ids.dish = ok(await api('POST', '/vendor/menu', { token: owner, body: { name: 'Brochette', price_rwf: 3000, preparation_time_minutes: 25, department_id: ids.department_id } }), 201).id;
  ids.stock = ok(await api('POST', '/vendor/inventory', { token: owner, body: { name: 'Beef', unit: 'kg', quantity: 10, kind: 'ingredient' } }), 201).id;
  ids.supplier_id = ok(await api('POST', '/vendor/suppliers', { token: owner, body: { name: 'Market' } }), 201).id;
  const table = ok(await api('POST', '/vendor/tables', { token: owner, body: { label: 'P1', capacity: 4 } }), 201);
  ids.table_id = table.id;
  const placed = ok(await api('POST', `/tables/${table.token}/orders`, { body: { items: [{ menu_item_id: ids.dish, quantity: 1 }] } }), 201);
  ids.order_id = placed.order.id;
  const order = await Order.findById(ids.order_id).lean();
  ids.ticket_id = String(order.tickets[0]._id);
  ids.order_item = String(order.items[0]._id);
  ids.session_id = String(order.table_session_id);
  ids.invoice_id = String((await Invoice.findOne({ order_ids: order._id }).lean())._id);
  ids.reservation_id = ok(await api('POST', '/vendor/reservations', { token: owner, body: { name: 'Booked Guest', party_size: 2, starts_at: new Date(Date.now() + 3 * 86400000).toISOString() } }), 201).id;
  ids.role_id = ok(await api('POST', '/vendor/roles', { token: owner, body: { name: 'Fixture role', permissions: ['orders.view'] } }), 201).id;
  ids.staff_id = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Target Employee', username: 'target.emp' } }), 201).id;
  ids.entry_id = ok(await api('POST', '/vendor/waitlist', { token: owner, body: { name: 'Waiting Party', party_size: 2 } }), 201).id;
  ids.promotion_id = ok(await api('POST', '/vendor/promotions', { token: owner, body: { name: 'Lunch', kind: 'automatic', discount_type: 'percent', value: 10, applies_to: 'all' } }), 201).id;
  ids.expense_id = ok(await api('POST', '/vendor/finance/expenses', { token: owner, body: { date: new Date().toISOString().slice(0, 10), category: 'Other', description: 'Gas', amount_rwf: 5000 } }), 201).id;
  ids.customer_id = ok(await api('POST', '/vendor/customers', { token: owner, body: { name: 'Regular Rita', phone: '0788999111' } }), 201).id;
  ids.shift_id = ok(await api('POST', '/vendor/shifts', { token: owner, body: { staff_id: ids.staff_id, starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: new Date(Date.now() + 86400000 + 8 * 3600000).toISOString() } }), 201).id;
  ids.po_id = ok(await api('POST', '/vendor/purchase-orders', { token: owner, body: { supplier_id: ids.supplier_id, lines: [{ item_id: ids.stock, quantity: 5, unit_cost_rwf: 4000 }] } }), 201).id;
});
after(stop);

const fake = '0123456789abcdef01234567';
/** Fills a route's path with real records (an item id depends on where it is). */
function pathFor(route) {
  const [, path] = route.split(' ');
  return path.replace(/:([a-z_]+)/g, (_, name) => {
    if (name === 'item_id') {
      if (path.startsWith('/vendor/menu')) return ids.dish;
      if (path.startsWith('/vendor/inventory')) return ids.stock;
      if (path.includes('/orders/')) return ids.order_item;
    }
    if (name === 'index') return '0';
    if (name === 'category_id') return fake;
    return ids[name] || fake;
  });
}

const ROUTE_SKIP = ['POST /vendor/auth'];
// Correct refusals that depend on the record, not on a missing permission:
// "transfer" moves something already given to someone; giving it the first
// time is "assign" (the fixtures have no server or table yet for these).
const RECORD_RULES = new Set([
  'PATCH /vendor/orders/:order_id/assign [service.transfer_servers]',
  'PUT /vendor/orders/:order_id/table [tables.assign_orders]',
  'PUT /vendor/table-sessions/:session_id/server [service.transfer_servers]',
  // The fixture item is an ingredient: "Raw materials" covers raw materials only.
  'PATCH /vendor/inventory/:item_id [inventory.raw_materials]',
]);

test('default roles do their everyday jobs', async () => {
  const roles = Object.fromEntries(access.DEFAULT_ROLES.map((r) => [r.key, r.permissions]));
  // Stock manager: add an item, receive stock, use some, record waste, correct a count, see the history, remove an item.
  const stock = await employeeWith(roles.stock_manager, 'Stock Manager');
  const flour = ok(await api('POST', '/vendor/inventory', { token: stock.token, body: { name: 'Flour', unit: 'kg', quantity: 20, kind: 'raw_material', low_stock_threshold: 5 } }), 201);
  let after = ok(await api('POST', `/vendor/inventory/${flour.id}/adjust`, { token: stock.token, body: { reason: 'purchase', delta: 10 } }));
  assert.equal(after.quantity, 30);
  after = ok(await api('POST', `/vendor/inventory/${flour.id}/adjust`, { token: stock.token, body: { reason: 'usage', delta: 4 } }));
  after = ok(await api('POST', `/vendor/inventory/${flour.id}/adjust`, { token: stock.token, body: { reason: 'waste', delta: 1, note: 'Damp bag' } }));
  after = ok(await api('POST', `/vendor/inventory/${flour.id}/adjust`, { token: stock.token, body: { reason: 'adjustment', delta: -5 } }));
  assert.equal(after.quantity, 20);
  ok(await api('PATCH', `/vendor/inventory/${flour.id}`, { token: stock.token, body: { low_stock_threshold: 8 } }));
  assert.ok(ok(await api('GET', '/vendor/inventory/movements', { token: stock.token })).movements.length >= 4);
  const supplier = ok(await api('POST', '/vendor/suppliers', { token: owner, body: { name: 'Mill' } }), 201);
  const po = ok(await api('POST', '/vendor/purchase-orders', { token: owner, body: { supplier_id: supplier.id, lines: [{ item_id: flour.id, quantity: 5, unit_cost_rwf: 900 }] } }), 201);
  after = ok(await api('POST', `/vendor/purchase-orders/${po.id}/receive`, { token: stock.token, body: {} }));
  ok(await api('DELETE', `/vendor/inventory/${flour.id}`, { token: stock.token }));
  // Not their job: the menu prices or bills.
  assert.equal((await api('PUT', `/vendor/menu/${ids.dish}`, { token: stock.token, body: { price_rwf: 1 } })).status, 403);

  // A clerk who only handles ingredients: their kind of item, not the others.
  const clerk = await employeeWith(['inventory.view', 'inventory.ingredients'], 'Ingredients Clerk');
  const salt = ok(await api('POST', '/vendor/inventory', { token: clerk.token, body: { name: 'Salt', unit: 'kg', kind: 'ingredient' } }), 201);
  ok(await api('PATCH', `/vendor/inventory/${salt.id}`, { token: clerk.token, body: { name: 'Sea salt' } }));
  assert.equal((await api('POST', '/vendor/inventory', { token: clerk.token, body: { name: 'Gloves', unit: 'box', kind: 'supply' } })).status, 403);

  // Chef: sees the queue and cooks a ticket to ready (only the stages they hold).
  const chef = await employeeWith(roles.chef, 'Chef');
  const queue = ok(await api('GET', '/vendor/kitchen/queue', { token: chef.token }));
  const ticket = queue.tickets.find((t) => t.order.id === ids.order_id);
  assert.ok(ticket.allowed_next_statuses.some((n) => n.id === 'ready'));
  ok(await api('PATCH', `/vendor/kitchen/orders/${ids.order_id}/tickets/${ticket.id}`, { token: chef.token, body: { status: 'ready' } }));
  // A cook without "mark ready" isn't offered it.
  const cook = await employeeWith(['kitchen.view_queue', 'kitchen.start_preparation'], 'Line Cook');
  const another = ok(await api('POST', `/tables/${(await api('GET', `/vendor/tables/${ids.table_id}`, { token: owner })).body.token}/orders`, { body: { items: [{ menu_item_id: ids.dish, quantity: 1 }] } }), 201);
  const cookView = ok(await api('GET', '/vendor/kitchen/queue', { token: cook.token })).tickets.find((t) => t.order.id === another.order.id);
  assert.deepEqual(cookView.allowed_next_statuses.map((n) => n.id), ['preparing']);

  // Menu: someone who may only change prices changes a price, not the name.
  const pricer = await employeeWith(['menu.view', 'menu.prices'], 'Price Editor');
  ok(await api('PUT', `/vendor/menu/${ids.dish}`, { token: pricer.token, body: { price_rwf: 3500 } }));
  assert.equal((await api('PUT', `/vendor/menu/${ids.dish}`, { token: pricer.token, body: { name: 'Renamed' } })).status, 403);

  // Cashier: opens a till, sees their own till, takes cash, prints the receipt.
  const cashier = await employeeWith(roles.cashier, 'Cashier');
  ok(await api('POST', '/vendor/cashier/sessions', { token: cashier.token, body: { opening_float_rwf: 10000 } }), 201);
  assert.ok(ok(await api('GET', '/vendor/cashier/sessions', { token: cashier.token })).mine);
  const bill = ok(await api('GET', `/vendor/invoices/${ids.invoice_id}`, { token: cashier.token }));
  ok(await api('POST', `/vendor/invoices/${ids.invoice_id}/payments`, { token: cashier.token, body: { amount_rwf: bill.total_rwf - bill.amount_paid_rwf, idempotency_key: 'test-payment-key-0001', method: 'cash' } }));
  const receipt = await fetch(`${baseUrl()}/vendor/invoices/${ids.invoice_id}/document?kind=receipt`, { headers: { Authorization: `Bearer ${cashier.token}` } });
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /Paid in full/);

  // Order desk: a new app order can be accepted by someone who may accept, and is offered only that.
  const desk = await employeeWith(['orders.view', 'orders.accept'], 'Order Desk');
  const app = await Order.create({
    order_number: 'OFK-TEST-DESK', customer_id: (await createCustomer()).customer.id, vendor_id: K.vendor._id, items: [{ menu_item_id: ids.dish, name: 'Brochette', price_rwf: 3000, quantity: 1, subtotal_rwf: 3000 }],
    subtotal_rwf: 3000, delivery_fee_rwf: 0, total_rwf: 3000, fulfillment: 'pickup', payment_method: 'mobile_money', payment_status: 'paid', status: 'placed',
  });
  const seen = ok(await api('GET', `/vendor/orders/${app._id}`, { token: desk.token }));
  assert.deepEqual(seen.allowed_next_statuses, ['accepted']);
  ok(await api('PATCH', `/vendor/orders/${app._id}/status`, { token: desk.token, body: { status: 'accepted' } }));

  // Reviews only: the public reviews, not private feedback.
  const reviews = await employeeWith(['customers.reviews'], 'Reviews');
  ok(await api('GET', '/vendor/feedback', { token: reviews.token }));
});

test('every route lets each permission it accepts through (no 403 for a held permission)', async () => {
  const routes = require('../../src/config/routeAccess').all();
  const refused = [];
  const order = (k) => (k.startsWith('GET') ? 0 : k.startsWith('DELETE') ? 2 : 1);
  const keys = Object.keys(routes).filter((k) => !ROUTE_SKIP.some((s) => k.startsWith(s))).sort((a, b) => order(a) - order(b));
  for (const key of keys) {
    const permissions = routes[key];
    if (!permissions.length || permissions.includes('admin')) continue;
    const [method] = key.split(' ');
    for (const permission of permissions) {
      if (access.PERMISSIONS[permission]?.owner) continue; // administrator-only: never in a role
      const token = await only(permission);
      const withBody = method !== 'GET' && method !== 'DELETE';
      const res = await fetch(`${baseUrl()}${pathFor(key)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(withBody ? { 'Content-Type': 'application/json' } : {}) },
        body: withBody ? '{}' : undefined,
      });
      if (res.status !== 403 || RECORD_RULES.has(`${key} [${permission}]`)) continue;
      const error = (await res.json().catch(() => ({})))?.error || {};
      // Someone else's table: the record, not the permission.
      if (error.code === 'NOT_YOUR_TABLE') continue;
      refused.push(`${key}  [${permission}]  ${error.message || ''}`);
    }
  }
  assert.deepEqual(refused, [], `Granted but refused:\n${refused.join('\n')}`);
});

test('every permission that can go in a role is used by some route or rule', () => {
  const routes = require('../../src/config/routeAccess').all();
  const accepted = new Set(Object.values(routes).flat());
  // Checked inside the services for a specific step (status, field, section).
  const inService = new Set([
    'orders.accept', 'orders.reject', 'orders.cancel', 'orders.handover', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.update_progress',
    'kitchen.mark_ready', 'kitchen.view_history', 'overview.statistics', 'overview.sales', 'overview.orders', 'overview.pending_orders',
    'overview.active_tables', 'overview.active_employees', 'delivery.view_locations', 'delivery.confirm_completion', 'customers.order_history',
    'invoices.partial', 'invoices.payment_history',
    // Extra steps on top of a base permission (creating a promotion, closing a table, editing a booking).
    'menu.promotions', 'promotions.codes', 'promotions.campaigns', 'promotions.products', 'promotions.departments',
    'tables.session_override', 'reservations.preorders', 'notifications.preferences',
  ]);
  const unused = access.PERMISSION_KEYS.filter((key) => !access.PERMISSIONS[key].owner && !accepted.has(key) && !inService.has(key));
  assert.deepEqual(unused, [], `Permissions nothing checks: ${unused.join(', ')}`);
});

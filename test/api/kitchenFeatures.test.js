// The full kitchen permission list in action: order editing, ticket control,
// tables and bills, cashier tills, finance, stock, customers and loyalty,
// reservations, promotions, the team inbox, schedules and attendance.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, baseUrl, createKitchen, createCustomer, MOBILE_MONEY } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const { Order, Vendor, MenuItem } = require('../../src/models');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};
const tokenFor = (vendor, staffId) => signToken({ sub: String(vendor._id), role: 'vendor', ...(staffId ? { staff_id: String(staffId) } : {}) });

let K;
let owner;
const dept = {};
const dish = {};
const tables = {};

/** An employee with exactly these permissions (a role made for them). */
async function employee(name, phone, permissions, extra = {}) {
  const role = ok(await api('POST', '/vendor/roles', { token: owner, body: { name: `${name} role`, permissions } }), 201);
  const staff = ok(await api('POST', '/vendor/staff', { token: owner, body: { name, phone, role_ids: [role.id], ...extra } }), 201);
  return { id: staff.id, token: tokenFor(K.vendor, staff.id) };
}

async function tableOrder(tableKey, items) {
  return ok(await api('POST', `/tables/${tables[tableKey].token}/orders`, { body: { items } }), 201);
}

before(async () => {
  await start();
  K = await createKitchen({ name: 'Feature Kitchen' });
  owner = tokenFor(K.vendor);
  for (const [key, name, category] of [['food', 'Food', 'restaurant'], ['coffee', 'Coffee', 'coffee']]) {
    dept[key] = ok(await api('POST', '/vendor/departments', { token: owner, body: { name, category } }), 201).id;
  }
  for (const [key, name, price, d] of [['burger', 'Burger', 5000, 'food'], ['salad', 'Salad', 3000, 'food'], ['latte', 'Latte', 2000, 'coffee']]) {
    dish[key] = ok(await api('POST', '/vendor/menu', { token: owner, body: { name, price_rwf: price, department_id: dept[d] } }), 201).id;
  }
  for (const label of ['T1', 'T2', 'T3']) tables[label] = ok(await api('POST', '/vendor/tables', { token: owner, body: { label, capacity: 4 } }), 201);
});
after(stop);

test('the permission list has 21 groups; only administrators shape roles', async () => {
  const catalogue = ok(await api('GET', '/vendor/permissions', { token: owner }));
  assert.equal(catalogue.groups.length, 21);
  const all = catalogue.groups.flatMap((g) => g.permissions);
  assert.ok(all.length > 230);
  assert.equal(all.filter((p) => p.planned).length, 0, 'every permission does something');
  assert.ok(all.find((p) => p.key === 'roles.create').admin_only);
  // Even an employee who manages staff can't create roles or hand them out.
  const hr = await employee('Hana HR', '0788600001', ['staff.view', 'staff.create', 'staff.edit']);
  assert.equal((await api('POST', '/vendor/roles', { token: hr.token, body: { name: 'Sneaky', permissions: ['orders.view'] } })).status, 403);
  const roles = ok(await api('GET', '/vendor/roles', { token: owner })).roles;
  assert.equal((await api('PATCH', `/vendor/staff/${hr.id}`, { token: hr.token, body: { role_ids: [roles[0].id] } })).status, 403);
  const other = ok(await api('POST', '/vendor/staff', { token: hr.token, body: { name: 'New Hire', username: 'new.hire' } }), 201);
  assert.equal((await api('PATCH', `/vendor/staff/${other.id}`, { token: hr.token, body: { role_ids: [roles[0].id] } })).status, 403);
});

test('dashboard figures and settings fields follow the permissions', async () => {
  const counter = await employee('Dina Dashboard', '0788600002', ['overview.dashboard', 'overview.orders', 'settings.contact']);
  const dashboard = ok(await api('GET', '/vendor/dashboard', { token: counter.token }));
  assert.ok(!JSON.stringify(dashboard).includes('_sales_rwf'), 'no money without overview.sales');
  assert.ok(!JSON.stringify(dashboard).includes('balance_rwf'), 'no balances without the wallet');
  assert.equal((await api('PATCH', '/vendor/profile', { token: counter.token, body: { name: 'Renamed' } })).status, 403);
});

test('orders: priority, editing items on an unpaid table bill, moving an item, reopening', async () => {
  const placed = await tableOrder('T1', [{ menu_item_id: dish.burger, quantity: 1 }]);
  const id = placed.order.id;
  const editor = await employee('Eddie Editor', '0788600003', ['orders.view', 'orders.priorities', 'orders.add_items', 'orders.quantities', 'orders.remove_items', 'orders.assign_departments', 'orders.reopen', 'service.serve', 'service.view_ready', 'kitchen.mark_ready', 'kitchen.view_queue']);
  ok(await api('PATCH', `/vendor/orders/${id}/priority`, { token: editor.token, body: { priority: 'urgent' } }));
  let view = ok(await api('POST', `/vendor/orders/${id}/items`, { token: editor.token, body: { menu_item_id: dish.latte, quantity: 2 } }), 201);
  assert.equal(view.total_rwf, 9000);
  assert.equal(view.tickets.length, 2, 'the coffee got its own ticket');
  const latte = view.items.find((i) => i.name === 'Latte');
  view = ok(await api('PATCH', `/vendor/orders/${id}/items/${latte.id}`, { token: editor.token, body: { quantity: 3 } }));
  assert.equal(view.total_rwf, 11000);
  const bill = ok(await api('GET', `/vendor/invoices/${(await Order.findById(id)).invoice_id}`, { token: owner }));
  assert.equal(bill.total_rwf, 11000, 'the bill follows the order');
  // Move the latte to the food department, then remove it.
  view = ok(await api('PATCH', `/vendor/orders/${id}/items/${latte.id}/department`, { token: editor.token, body: { department_id: dept.food } }));
  assert.equal(view.items.find((i) => i.id === latte.id).department_name, 'Food');
  view = ok(await api('DELETE', `/vendor/orders/${id}/items/${latte.id}`, { token: editor.token }));
  assert.equal(view.total_rwf, 5000);
  // The queue shows urgent orders first.
  const queue = ok(await api('GET', '/vendor/kitchen/queue', { token: editor.token }));
  assert.equal(queue.tickets[0].order.priority, 'urgent');
  // Serve it, then reopen.
  const order = await Order.findById(id).lean();
  for (const t of order.tickets.filter((x) => x.status !== 'cancelled')) ok(await api('PATCH', `/vendor/kitchen/orders/${id}/tickets/${t._id}`, { token: owner, body: { status: 'ready' } }));
  ok(await api('POST', `/vendor/service/orders/${id}/serve`, { token: editor.token, body: {} }));
  view = ok(await api('POST', `/vendor/orders/${id}/reopen`, { token: editor.token, body: { reason: 'Forgot the sauce' } }));
  assert.equal(view.status, 'ready');
  const history = ok(await api('GET', `/vendor/orders/${id}/history`, { token: owner }));
  assert.ok(history.timeline.some((e) => /Forgot the sauce/.test(e.text)));
  // App orders paid online can't be edited.
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.salad, quantity: 1 } });
  const appOrder = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { fulfillment: 'pickup', ...MOBILE_MONEY } }));
  assert.equal((await api('POST', `/vendor/orders/${appOrder.id}/items`, { token: editor.token, body: { menu_item_id: dish.latte } })).status, 409);
});

test('tickets: pause blocks progress; cancelling a department part lowers the bill', async () => {
  const placed = await tableOrder('T2', [{ menu_item_id: dish.burger, quantity: 1 }, { menu_item_id: dish.latte, quantity: 1 }]);
  const order = await Order.findById(placed.order.id).lean();
  const coffee = order.tickets.find((t) => String(t.department_id) === dept.coffee);
  const barista = await employee('Bea Barista', '0788600004', ['kitchen.view_queue', 'kitchen.pause', 'kitchen.cancel_tasks', 'kitchen.start_preparation', 'kitchen.assign_tasks'], { department_ids: [dept.coffee] });
  ok(await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${coffee._id}/pause`, { token: barista.token, body: { paused: true, reason: 'No milk' } }));
  const blocked = await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${coffee._id}`, { token: barista.token, body: { status: 'preparing' } });
  assert.equal(blocked.body.error.code, 'TICKET_PAUSED');
  ok(await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${coffee._id}/assign`, { token: barista.token, body: { staff_id: barista.id } }));
  ok(await api('POST', `/vendor/kitchen/orders/${order._id}/tickets/${coffee._id}/cancel`, { token: barista.token, body: { reason: 'Machine broken' } }));
  const bill = ok(await api('GET', `/vendor/invoices/${order.invoice_id}`, { token: owner }));
  assert.equal(bill.total_rwf, 5000);
  // A barista can't touch the food ticket.
  const food = order.tickets.find((t) => String(t.department_id) === dept.food);
  assert.equal((await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${food._id}/pause`, { token: barista.token, body: { paused: true } })).status, 403);
});

test('tables and bills: move an order, merge tables, split and cancel bills', async () => {
  const a = await tableOrder('T3', [{ menu_item_id: dish.burger, quantity: 2 }]);
  const host = await employee('Hugo Host', '0788600005', ['tables.view', 'tables.transfer_orders', 'tables.merge', 'invoices.split', 'invoices.view', 'invoices.cancel']);
  ok(await api('PUT', `/vendor/orders/${a.order.id}/table`, { token: host.token, body: { table_id: tables.T1.id } }));
  const moved = await Order.findById(a.order.id).lean();
  assert.equal(moved.table.label, 'T1');
  const t1Bill = ok(await api('GET', `/vendor/invoices/${moved.invoice_id}`, { token: owner }));
  assert.equal(t1Bill.table.label, 'T1');
  // T2's bill joins T1's.
  ok(await api('POST', `/vendor/tables/${tables.T1.id}/merge`, { token: host.token, body: { from_table_id: tables.T2.id } }));
  const merged = ok(await api('GET', `/vendor/invoices/${moved.invoice_id}`, { token: owner }));
  assert.ok(merged.lines.filter((l) => !l.voided).length >= 2);
  // Split one line off into its own bill.
  const line = merged.lines.find((l) => !l.voided);
  const split = ok(await api('POST', `/vendor/invoices/${merged.id}/split`, { token: host.token, body: { line_ids: [line.id] } }));
  assert.equal(split.created.lines.length, 1);
  assert.equal(split.original.total_rwf + split.created.total_rwf, merged.total_rwf);
  ok(await api('POST', `/vendor/invoices/${split.created.id}/cancel`, { token: host.token, body: { reason: 'Guest left' } }));
  assert.equal(ok(await api('GET', `/vendor/invoices/${split.created.id}`, { token: owner })).status, 'void');
});

test('guests call the waiter from the table; servers handle it', async () => {
  const sent = ok(await api('POST', `/tables/${tables.T3.token}/requests`, { body: { kind: 'request_bill' } }), 201);
  assert.equal(sent.request.kind, 'request_bill');
  const server = await employee('Sid Server', '0788600006', ['service.customer_requests', 'service.view_ready']);
  const list = ok(await api('GET', '/vendor/service/requests', { token: server.token }));
  assert.equal(list.requests[0].table.label, 'T3');
  ok(await api('PATCH', `/vendor/service/requests/${list.requests[0].id}`, { token: server.token, body: { status: 'done' } }));
  assert.equal(ok(await api('GET', `/tables/${tables.T3.token}/requests`)).requests.length, 0);
});

test('cashier till: open, take cash, close with the counted cash', async () => {
  const placed = await tableOrder('T3', [{ menu_item_id: dish.salad, quantity: 1 }]);
  const cashier = await employee('Cleo Cashier', '0788600007', ['invoices.view', 'invoices.cash', 'invoices.cashier_sessions', 'invoices.cashier_reports']);
  const session = ok(await api('POST', '/vendor/cashier/sessions', { token: cashier.token, body: { opening_float_rwf: 10000 } }), 201);
  const order = await Order.findById(placed.order.id).lean();
  const bill = ok(await api('GET', `/vendor/invoices/${order.invoice_id}`, { token: owner }));
  // Cash only: digital payments need another permission.
  assert.equal((await api('POST', `/vendor/invoices/${bill.id}/payments`, { token: cashier.token, body: { amount_rwf: bill.balance_due_rwf, idempotency_key: 'test-payment-key-0002', method: 'card' } })).status, 403);
  ok(await api('POST', `/vendor/invoices/${bill.id}/payments`, { token: cashier.token, body: { amount_rwf: bill.balance_due_rwf, idempotency_key: 'test-payment-key-0003', method: 'cash' } }));
  const closed = ok(await api('POST', `/vendor/cashier/sessions/${session.id}/close`, { token: cashier.token, body: { counted_cash_rwf: 10000 + bill.balance_due_rwf } }));
  assert.equal(closed.difference_rwf, 0);
  const report = ok(await api('GET', '/vendor/cashier/report', { token: cashier.token }));
  assert.ok(report.cashiers.some((c) => c.cashier === 'Cleo Cashier'));
});

test('finance: expenses, profit and loss, transactions', async () => {
  const accountant = await employee('Ali Accounts', '0788600008', ['finance.expenses_view', 'finance.expenses_record', 'finance.expenses_edit', 'finance.expenses_delete', 'finance.profit_loss', 'finance.transactions']);
  const expense = ok(await api('POST', '/vendor/finance/expenses', { token: accountant.token, body: { category: 'Rent', amount_rwf: 2000, description: 'Half day' } }), 201);
  ok(await api('PATCH', `/vendor/finance/expenses/${expense.id}`, { token: accountant.token, body: { amount_rwf: 2500 } }));
  const list = ok(await api('GET', '/vendor/finance/expenses', { token: accountant.token }));
  assert.equal(list.total_rwf, 2500);
  const pnl = ok(await api('GET', '/vendor/finance/profit-loss?period=daily', { token: accountant.token }));
  assert.ok(pnl.revenue.total_rwf > 0);
  assert.equal(pnl.costs.expenses_rwf, 2500);
  assert.equal(pnl.profit_rwf, pnl.revenue.total_rwf - pnl.costs.commission_rwf - pnl.costs.refunds_rwf - 2500);
  const tx = ok(await api('GET', '/vendor/finance/transactions', { token: accountant.token }));
  assert.ok(tx.transactions.some((t) => t.kind === 'expense'));
  ok(await api('DELETE', `/vendor/finance/expenses/${expense.id}`, { token: accountant.token }));
});

test('stock: categories, transfers between departments, purchase orders', async () => {
  const beans = ok(await api('POST', '/vendor/inventory', { token: owner, body: { name: 'Beans', unit: 'kg', quantity: 10, department_id: dept.food, category: 'Dry goods', cost_per_unit_rwf: 1000 } }), 201);
  const moved = ok(await api('POST', `/vendor/inventory/${beans.id}/transfer`, { token: owner, body: { to_department_id: dept.coffee, quantity: 4 } }));
  assert.equal(moved.from.quantity, 6);
  ok(await api('PATCH', '/vendor/inventory/categories', { token: owner, body: { from: 'Dry goods', to: 'Pantry' } }));
  const stock = ok(await api('GET', '/vendor/inventory', { token: owner }));
  assert.deepEqual(stock.categories, ['Pantry']);
  const coffeeBeans = stock.items.find((i) => i.name === 'Beans' && i.department_id === dept.coffee);
  assert.equal(coffeeBeans.quantity, 4);
  const supplier = ok(await api('POST', '/vendor/suppliers', { token: owner, body: { name: 'Bean Co' } }), 201);
  const po = ok(await api('POST', '/vendor/purchase-orders', { token: owner, body: { supplier_id: supplier.id, lines: [{ item_id: coffeeBeans.id, quantity: 5, unit_cost_rwf: 900 }] } }), 201);
  assert.equal(po.total_rwf, 4500);
  ok(await api('PATCH', `/vendor/purchase-orders/${po.id}`, { token: owner, body: { status: 'sent' } }));
  const received = ok(await api('POST', `/vendor/purchase-orders/${po.id}/receive`, { token: owner, body: {} }));
  assert.equal(received.status, 'received');
  const after = ok(await api('GET', '/vendor/inventory', { token: owner })).items.find((i) => i.id === coffeeBeans.id);
  assert.equal(after.quantity, 9);
  const expenses = ok(await api('GET', '/vendor/finance/expenses', { token: owner }));
  assert.ok(expenses.expenses.some((e) => e.from_purchase_order && e.amount_rwf === 4500));
});

test('customers and loyalty: earn on a paid bill, spend points, personal discount', async () => {
  ok(await api('PUT', '/vendor/operations', { token: owner, body: { loyalty: { enabled: true, earn_per_rwf: 1000, point_value_rwf: 100 } } }));
  const regular = ok(await api('POST', '/vendor/customers', { token: owner, body: { name: 'Regular Rita', phone: '0788600099', tags: ['vip'] } }), 201);
  const placed = await tableOrder('T3', [{ menu_item_id: dish.burger, quantity: 2 }]);
  const order = await Order.findById(placed.order.id).lean();
  let bill = ok(await api('PUT', `/vendor/invoices/${order.invoice_id}/customer`, { token: owner, body: { customer_id: regular.id } }));
  ok(await api('POST', `/vendor/invoices/${bill.id}/payments`, { token: owner, body: { amount_rwf: bill.balance_due_rwf, idempotency_key: 'test-payment-key-0004', method: 'cash' } }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  let profile = ok(await api('GET', `/vendor/customers/${regular.id}`, { token: owner }));
  assert.ok(profile.loyalty_points >= 10, `earned points, got ${profile.loyalty_points}`);
  // Spend 5 points (RWF 500) on the next bill, with a 10% standing discount.
  ok(await api('PATCH', `/vendor/customers/${regular.id}`, { token: owner, body: { discount_percent: 10 } }));
  const next = await tableOrder('T3', [{ menu_item_id: dish.salad, quantity: 2 }]);
  const nextOrder = await Order.findById(next.order.id).lean();
  bill = ok(await api('PUT', `/vendor/invoices/${nextOrder.invoice_id}/customer`, { token: owner, body: { customer_id: regular.id } }));
  assert.equal(bill.discount_rwf, 600);
  bill = ok(await api('POST', `/vendor/invoices/${bill.id}/redeem-points`, { token: owner, body: { points: 5 } }));
  assert.equal(bill.total_rwf, 6000 - 600 - 500);
  profile = ok(await api('GET', `/vendor/customers/${regular.id}`, { token: owner }));
  assert.ok(profile.orders.length >= 1);
});

test('feedback from the table, a reply, and public reviews on the kitchen page', async () => {
  const placed = await tableOrder('T3', [{ menu_item_id: dish.latte, quantity: 1 }]);
  ok(await api('POST', `/tables/${tables.T3.token}/orders/${placed.order.id}/feedback`, { headers: { 'x-guest-key': placed.guest_key }, body: { rating: 4, comment: 'Lovely coffee', is_public: true } }), 201);
  assert.equal((await api('POST', `/tables/${tables.T3.token}/orders/${placed.order.id}/feedback`, { headers: { 'x-guest-key': placed.guest_key }, body: { rating: 5 } })).status, 409);
  const fb = ok(await api('GET', '/vendor/feedback', { token: owner }));
  assert.equal(fb.average_rating, 4);
  ok(await api('POST', `/vendor/feedback/${fb.feedback[0].id}/reply`, { token: owner, body: { reply: 'Thank you!' } }));
  const page = ok(await api('GET', `/vendors/${K.vendor._id}`));
  assert.equal(page.reviews[0].reply, 'Thank you!');
});

test('reservations: book, availability, no double booking, seat', async () => {
  const at = new Date(Date.now() + 2 * 86400000).toISOString();
  const host = await employee('Rosa Reservations', '0788600010', ['reservations.view', 'reservations.create', 'reservations.assign_tables', 'reservations.edit', 'reservations.table_availability', 'reservations.active_sessions']);
  const booking = ok(await api('POST', '/vendor/reservations', { token: host.token, body: { name: 'Mugisha family', party_size: 4, starts_at: at, table_id: tables.T2.id } }), 201);
  assert.equal(booking.table.label, 'T2');
  assert.equal((await api('POST', '/vendor/reservations', { token: host.token, body: { name: 'Clash', party_size: 2, starts_at: at, table_id: tables.T2.id } })).status, 409);
  const availability = ok(await api('GET', `/vendor/reservations/availability?at=${encodeURIComponent(at)}&party_size=4`, { token: host.token }));
  assert.equal(availability.tables.find((t) => t.label === 'T2').free, false);
  assert.equal(availability.tables.find((t) => t.label === 'T3').free, true);
  const seated = ok(await api('PATCH', `/vendor/reservations/${booking.id}`, { token: host.token, body: { status: 'seated' } }));
  assert.equal(seated.status, 'seated');
  const sessions = ok(await api('GET', '/vendor/sessions', { token: host.token }));
  assert.ok(sessions.sessions.some((s) => s.reservation?.id === booking.id));
});

test('promotions: an automatic campaign and a limited code on table bills', async () => {
  const marketer = await employee('Mia Marketing', '0788600011', ['promotions.view', 'promotions.create', 'promotions.campaigns', 'promotions.codes', 'promotions.departments', 'invoices.discounts', 'invoices.view']);
  ok(await api('POST', '/vendor/promotions', { token: marketer.token, body: { name: 'Coffee hour', kind: 'automatic', discount_type: 'percent', value: 50, applies_to: 'departments', department_ids: [dept.coffee] } }), 201);
  const code = ok(await api('POST', '/vendor/promotions', { token: marketer.token, body: { name: 'Welcome', kind: 'code', code: 'welcome1', discount_type: 'amount', value: 1000, usage_limit: 1 } }), 201);
  assert.equal(code.code, 'WELCOME1');
  const placed = await tableOrder('T1', [{ menu_item_id: dish.latte, quantity: 2 }, { menu_item_id: dish.burger, quantity: 1 }]);
  const order = await Order.findById(placed.order.id).lean();
  let bill = ok(await api('GET', `/vendor/invoices/${order.invoice_id}`, { token: owner }));
  assert.ok(bill.promotions.some((p) => p.name === 'Coffee hour' && p.amount_rwf === 2000));
  const before = bill.total_rwf;
  bill = ok(await api('POST', `/vendor/invoices/${bill.id}/apply-code`, { token: marketer.token, body: { code: 'welcome1' } }));
  assert.equal(bill.total_rwf, before - 1000);
  // Used once: the limit is reached.
  const other = await tableOrder('T2', [{ menu_item_id: dish.burger, quantity: 1 }]);
  const otherBill = (await Order.findById(other.order.id).lean()).invoice_id;
  assert.equal((await api('POST', `/vendor/invoices/${otherBill}/apply-code`, { token: marketer.token, body: { code: 'WELCOME1' } })).status, 400);
  const menu = ok(await api('GET', `/tables/${tables.T1.token}`));
  assert.ok(menu.promotions.some((p) => p.name === 'Coffee hour'));
});

test('team inbox: a message to a role, automatic alerts, muting', async () => {
  const roles = ok(await api('GET', '/vendor/roles', { token: owner })).roles;
  const chefRole = roles.find((r) => r.template_key === 'chef');
  const chef = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Cole Chef', phone: '0788600012', role_ids: [chefRole.id] } }), 201);
  const chefToken = tokenFor(K.vendor, chef.id);
  ok(await api('POST', '/vendor/inbox', { token: owner, body: { title: 'Team meeting at 3', to: { role_ids: [chefRole.id] } } }), 201);
  let inbox = ok(await api('GET', '/vendor/inbox', { token: chefToken }));
  assert.ok(inbox.items.some((n) => n.title === 'Team meeting at 3'));
  // A new order alerts whoever receives new orders (the kitchen manager role does).
  const receiver = await employee('Rex Receiver', '0788600013', ['orders.receive', 'notifications.preferences']);
  await tableOrder('T3', [{ menu_item_id: dish.salad, quantity: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  inbox = ok(await api('GET', '/vendor/inbox', { token: receiver.token }));
  assert.ok(inbox.items.some((n) => n.alert_type === 'order_alerts' && n.title.startsWith('New order')));
  ok(await api('PUT', '/vendor/inbox/preferences', { token: receiver.token, body: { muted: ['order_alerts'] } }));
  inbox = ok(await api('GET', '/vendor/inbox', { token: receiver.token }));
  assert.ok(!inbox.items.some((n) => n.alert_type === 'order_alerts'));
  ok(await api('POST', '/vendor/inbox/read-all', { token: chefToken }));
  assert.equal(ok(await api('GET', '/vendor/inbox', { token: chefToken })).unread_count, 0);
});

test('team: invitations, shifts, clocking in and out', async () => {
  const hr = await employee('Harriet HR', '0788600014', ['staff.view', 'staff.invite', 'staff.schedules', 'staff.attendance']);
  const newbie = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Nina New', phone: '0788600015' } }), 201);
  const invited = ok(await api('POST', `/vendor/staff/${newbie.id}/invite`, { token: hr.token }));
  assert.ok(invited.credentials.username && invited.credentials.password);
  const signedIn = ok(await api('POST', '/vendor/auth/staff-login', { body: { username: invited.credentials.username, password: invited.credentials.password } }));
  const start = new Date(Date.now() - 30 * 60000);
  ok(await api('POST', '/vendor/shifts', { token: hr.token, body: { staff_id: newbie.id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 8 * 3600000).toISOString() } }), 201);
  const mine = ok(await api('GET', '/vendor/shifts', { token: signedIn.token }));
  assert.equal(mine.shifts.length, 1);
  const clock = ok(await api('POST', '/vendor/attendance/clock-in', { token: signedIn.token, body: {} }), 201);
  assert.ok(clock.late_minutes >= 29, 'late against the shift');
  assert.equal((await api('POST', '/vendor/attendance/clock-in', { token: signedIn.token, body: {} })).status, 409);
  ok(await api('POST', '/vendor/attendance/clock-out', { token: signedIn.token }));
  const register = ok(await api('GET', '/vendor/attendance', { token: hr.token }));
  assert.equal(register.totals.find((t) => t.staff_id === newbie.id).late, 1);
});

test('the kitchen\'s own couriers for orders it delivers itself', async () => {
  const courierRole = ok(await api('POST', '/vendor/roles', { token: owner, body: { name: 'Courier', permissions: ['service.view_assigned'] } }), 201);
  const courier = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Cory Courier', phone: '0788600016', role_ids: [courierRole.id] } }), 201);
  const order = await Order.create({
    order_number: 'OFK-TEST-COURIER',
    customer_id: (await createCustomer()).customer.id,
    vendor_id: K.vendor._id,
    items: [{ menu_item_id: dish.burger, name: 'Burger', price_rwf: 5000, quantity: 1, subtotal_rwf: 5000 }],
    subtotal_rwf: 5000,
    delivery_fee_rwf: 3000,
    total_rwf: 8000,
    fulfillment: 'vendor_delivery',
    delivery_location: { address: 'Far away', latitude: -2.5, longitude: 29.6 },
    payment_method: 'mobile_money',
    payment_status: 'paid',
    status: 'ready',
  });
  const coordinator = await employee('Dee Dispatch', '0788600017', ['delivery.assign_workers', 'delivery.cancel_assignments', 'delivery.view_orders', 'delivery.view_locations']);
  const view = ok(await api('PUT', `/vendor/orders/${order._id}/courier`, { token: coordinator.token, body: { staff_id: courier.id } }));
  assert.equal(view.kitchen_courier.name, 'Cory Courier');
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: tokenFor(K.vendor, courier.id), body: { status: 'on_the_way' } }));
  const mine = ok(await api('GET', '/vendor/service/board?mine=true', { token: tokenFor(K.vendor, courier.id) }));
  assert.ok(mine.orders.some((o) => o.id === String(order._id)));
  ok(await api('DELETE', `/vendor/orders/${order._id}/courier`, { token: coordinator.token }));
});

test('menu categories the kitchen created can be renamed and deleted by it only', async () => {
  const created = ok(await api('POST', '/vendor/menu/categories', { token: owner, body: { name: 'House Specials Z' } }), 201);
  const renamed = ok(await api('PATCH', `/vendor/menu/categories/${created.category.id}`, { token: owner, body: { name: 'House Specials Y' } }));
  assert.equal(renamed.category.name, 'House Specials Y');
  const other = await createKitchen({ name: 'Other Kitchen', phone: '+250788600555' });
  assert.equal((await api('DELETE', `/vendor/menu/categories/${created.category.id}`, { token: tokenFor(other.vendor) })).status, 403);
  ok(await api('DELETE', `/vendor/menu/categories/${created.category.id}`, { token: owner }));
  void Vendor;
  void MenuItem;
  void baseUrl;
});

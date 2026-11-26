// Departments, staff roles and permissions, department tickets, table QR
// ordering, the server board, invoices, stock and reports — and that one
// kitchen can never reach another kitchen's data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen, createCustomer, NEARBY_ADDRESS, MOBILE_MONEY } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const { Order, Vendor } = require('../../src/models');

const ownerToken = (vendor) => signToken({ sub: String(vendor._id), role: 'vendor' });
const staffToken = (vendor, staffId) => signToken({ sub: String(vendor._id), role: 'vendor', staff_id: String(staffId) });

let A; // kitchen A: food, coffee and bakery
let B; // kitchen B: a second business, also with a "Table 1"
let ownerA;
let ownerB;
const dept = {};
const dish = {};
let tableA1;
let tableB1;
let baristaToken;
let chefToken;
let cashierToken;
let serverToken;

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

before(async () => {
  await start();
  A = await createKitchen({ name: 'Multi Service Kitchen' });
  B = await createKitchen({ name: 'Second Business', phone: '+250788000222' });
  ownerA = ownerToken(A.vendor);
  ownerB = ownerToken(B.vendor);
});
after(stop);

test('A. a kitchen creates food, coffee and bakery departments', async () => {
  for (const [key, category, name] of [['food', 'restaurant', 'Food'], ['coffee', 'coffee', 'Coffee'], ['bakery', 'bakery', 'Bakery']]) {
    const created = ok(await api('POST', '/vendor/departments', { token: ownerA, body: { name, category } }), 201);
    assert.equal(created.category, category);
    dept[key] = created.id;
  }
  // Bakery calls its preparation stage "Baking"; coffee skips the accept step.
  ok(await api('PATCH', `/vendor/departments/${dept.bakery}`, { token: ownerA, body: { workflow: { labels: { preparing: 'Baking' } } } }));
  const coffee = ok(await api('PATCH', `/vendor/departments/${dept.coffee}`, { token: ownerA, body: { workflow: { use_accept: false, labels: { ready: 'Ready for collection' } } } }));
  assert.deepEqual(coffee.workflow.stages.map((s) => s.id), ['pending', 'preparing', 'ready']);

  for (const [key, name, price, d] of [['burger', 'Burger', 5000, 'food'], ['fries', 'Fries', 2000, 'food'], ['cappuccino', 'Cappuccino', 2500, 'coffee'], ['cake', 'Chocolate Cake', 3000, 'bakery'], ['water', 'Water', 500, null]]) {
    const item = ok(await api('POST', '/vendor/menu', { token: ownerA, body: { name, price_rwf: price, department_id: d ? dept[d] : null } }), 201);
    assert.equal(item.department_id, d ? dept[d] : null);
    dish[key] = item.id;
  }
  // A department of another kitchen is refused.
  const bDept = ok(await api('POST', '/vendor/departments', { token: ownerB, body: { name: 'Bar', category: 'bar' } }), 201);
  const wrong = await api('POST', '/vendor/menu', { token: ownerA, body: { name: 'Stolen', price_rwf: 100, department_id: bDept.id } });
  assert.equal(wrong.status, 400);

  const list = ok(await api('GET', '/vendor/departments', { token: ownerA }));
  assert.equal(list.departments.length, 3);
  assert.equal(list.departments.find((d) => d.id === dept.food).product_count, 2);
});

test('B. custom roles and staff: permissions are enforced on the API, per department', async () => {
  const roles = ok(await api('GET', '/vendor/roles', { token: ownerA }));
  assert.ok(roles.roles.some((r) => r.name === 'Barista'), 'default roles exist');
  assert.ok(roles.catalogue.groups.length > 5);

  const prep = ['orders.view', 'kitchen.view_queue', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.mark_ready'];
  const prepRole = ok(await api('POST', '/vendor/roles', { token: ownerA, body: { name: 'Prep cook', permissions: prep } }), 201);
  // Wallet access can never be put in a role.
  const bad = await api('POST', '/vendor/roles', { token: ownerA, body: { name: 'Sneaky', permissions: ['account.wallet'] } });
  assert.equal(bad.status, 400);

  const barista = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Aline Barista', phone: '0788555001', role_ids: [prepRole.id], department_ids: [dept.coffee] } }), 201);
  const chef = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Eric Chef', phone: '0788555002', role_ids: [prepRole.id], department_ids: [dept.food] } }), 201);
  const cashierRole = roles.roles.find((r) => r.template_key === 'cashier');
  const serverRole = roles.roles.find((r) => r.template_key === 'server');
  const cashier = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Claude Cashier', phone: '0788555003', role_ids: [cashierRole.id] } }), 201);
  const server = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Sam Server', phone: '0788555004', role_ids: [serverRole.id] } }), 201);
  baristaToken = staffToken(A.vendor, barista.id);
  chefToken = staffToken(A.vendor, chef.id);
  cashierToken = staffToken(A.vendor, cashier.id);
  serverToken = staffToken(A.vendor, server.id);

  // The same phone can't sign in to two kitchens.
  const clash = await api('POST', '/vendor/staff', { token: ownerB, body: { name: 'Double', phone: '0788555001' } });
  assert.equal(clash.status, 409);

  const me = ok(await api('GET', '/vendor/auth/me', { token: baristaToken }));
  assert.equal(me.access.is_admin, false);
  assert.deepEqual(me.access.permissions['kitchen.view_queue'], [dept.coffee]);
  assert.deepEqual(me.vendor.payment_information, {}, 'payout details are hidden from staff');

  // Direct API calls outside the role are refused.
  for (const [method, path] of [['GET', '/vendor/wallet'], ['GET', '/vendor/staff'], ['GET', '/vendor/invoices'], ['POST', '/vendor/roles'], ['GET', '/vendor/dashboard'], ['PATCH', '/vendor/availability']]) {
    const res = await api(method, path, { token: baristaToken, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path} should be refused`);
  }
  // A cashier can't manage staff; a barista can't edit a food dish.
  assert.equal((await api('POST', '/vendor/staff', { token: cashierToken, body: { name: 'X', phone: '0788555099' } })).status, 403);
  const editFood = await api('PATCH', `/vendor/menu/${dish.burger}/availability`, { token: baristaToken, body: { is_available: false } });
  assert.equal(editFood.status, 403);

  // Nobody can change their own roles.
  const own = await api('PATCH', `/vendor/staff/${cashier.id}`, { token: cashierToken, body: { role_ids: [] } });
  assert.equal(own.status, 403);
});

test('D. tables get a unique QR token; a scan finds the right kitchen and table', async () => {
  tableA1 = ok(await api('POST', '/vendor/tables', { token: ownerA, body: { label: 'Table 1', capacity: 4 } }), 201);
  tableB1 = ok(await api('POST', '/vendor/tables', { token: ownerB, body: { label: 'Table 1' } }), 201);
  assert.notEqual(tableA1.token, tableB1.token);
  assert.ok(tableA1.menu_url.endsWith(`/menu/${tableA1.token}`));
  assert.ok(!tableA1.token.includes(String(A.vendor._id)), 'the token is not a database id');
  assert.equal((await api('POST', '/vendor/tables', { token: ownerA, body: { label: 'table 1' } })).status, 409, 'labels are unique per kitchen');

  const svg = await fetch(`${require('../helpers/testServer').baseUrl()}/vendor/tables/${tableA1.id}/qr`, { headers: { Authorization: `Bearer ${ownerA}` } });
  assert.equal(svg.status, 200);
  assert.match(await svg.text(), /^<svg/);

  const menuA = ok(await api('GET', `/tables/${tableA1.token}`));
  assert.equal(menuA.kitchen.name, 'Multi Service Kitchen');
  assert.equal(menuA.table.label, 'Table 1');
  assert.equal(menuA.departments.length, 3);
  const menuB = ok(await api('GET', `/tables/${tableB1.token}`));
  assert.equal(menuB.kitchen.name, 'Second Business');

  // Kitchen B can't see or print kitchen A's table.
  assert.equal((await api('GET', `/vendor/tables/${tableA1.id}`, { token: ownerB })).status, 404);
});

let tableOrder;
let guestKey;

test('C. one table order across three departments makes one order, three tickets, one bill', async () => {
  const placed = ok(
    await api('POST', `/tables/${tableA1.token}/orders`, {
      body: {
        guest_name: 'Table five family',
        items: [
          { menu_item_id: dish.burger, quantity: 1 },
          { menu_item_id: dish.fries, quantity: 1 },
          { menu_item_id: dish.cappuccino, quantity: 2 },
          { menu_item_id: dish.cake, quantity: 1 },
        ],
      },
    }),
    201
  );
  tableOrder = placed.order;
  guestKey = placed.guest_key;
  assert.equal(tableOrder.total_rwf, 5000 + 2000 + 5000 + 3000, 'priced on the server');
  assert.equal(tableOrder.departments.length, 3);
  const food = tableOrder.departments.find((d) => d.department_id === dept.food);
  assert.deepEqual(food.items.map((i) => i.name).sort(), ['Burger', 'Fries']);

  // The barista's queue has only the coffee ticket; the chef's only food.
  const coffeeQueue = ok(await api('GET', '/vendor/kitchen/queue', { token: baristaToken }));
  assert.equal(coffeeQueue.tickets.length, 1);
  assert.equal(coffeeQueue.tickets[0].department_id, dept.coffee);
  assert.deepEqual(coffeeQueue.tickets[0].items.map((i) => i.name), ['Cappuccino']);
  assert.equal(coffeeQueue.tickets[0].order.table_label, 'Table 1');
  const foodQueue = ok(await api('GET', '/vendor/kitchen/queue', { token: chefToken }));
  assert.equal(foodQueue.tickets.length, 1);
  assert.equal(foodQueue.tickets[0].department_id, dept.food);
  // Asking for another department's queue gives nothing.
  assert.equal(ok(await api('GET', `/vendor/kitchen/queue?department_id=${dept.food}`, { token: baristaToken })).tickets.length, 0);

  // One consolidated invoice for the table, split by department for reporting.
  const invoices = ok(await api('GET', '/vendor/invoices', { token: cashierToken }));
  assert.equal(invoices.invoices.length, 1);
  const invoice = ok(await api('GET', `/vendor/invoices/${invoices.invoices[0].id}`, { token: cashierToken }));
  assert.equal(invoice.total_rwf, 15000);
  assert.equal(invoice.departments.length, 3);
  assert.equal(invoice.table.label, 'Table 1');

  // The guest follows the order with their key; without it they can't.
  ok(await api('GET', `/tables/${tableA1.token}/orders/${tableOrder.id}`, { headers: { 'x-guest-key': guestKey } }));
  assert.equal((await api('GET', `/tables/${tableA1.token}/orders/${tableOrder.id}`)).status, 404);
  assert.equal((await api('GET', `/tables/${tableB1.token}/orders/${tableOrder.id}`, { headers: { 'x-guest-key': guestKey } })).status, 404);
});

test('C. departments prepare independently; servers collect ready items early; the order completes when served', async () => {
  const order = await Order.findById(tableOrder.id).lean();
  const ticketOf = (id) => order.tickets.find((t) => String(t.department_id) === id);
  const coffee = ticketOf(dept.coffee);
  const food = ticketOf(dept.food);
  const bakery = ticketOf(dept.bakery);
  const move = (token, ticket, status) => api('PATCH', `/vendor/kitchen/orders/${tableOrder.id}/tickets/${ticket._id}`, { token, body: { status } });

  // The chef can't touch the coffee ticket.
  assert.equal((await move(chefToken, coffee, 'preparing')).status, 403);
  // Coffee skips "accepted" in its workflow.
  assert.equal((await move(baristaToken, coffee, 'accepted')).status, 409);
  ok(await move(baristaToken, coffee, 'preparing'));
  let res = ok(await move(baristaToken, coffee, 'ready'));
  assert.equal(res.order_status, 'preparing', 'the order is preparing while the others are not done');

  // The server sees the coffee waiting and takes it before the rest is ready.
  const board = ok(await api('GET', '/vendor/service/board', { token: serverToken }));
  const onBoard = board.orders.find((o) => o.id === tableOrder.id);
  assert.equal(onBoard.destination.label, 'Table 1');
  assert.equal(onBoard.counts.waiting, 1);
  const cappuccino = onBoard.items.find((i) => i.name === 'Cappuccino');
  ok(await api('POST', `/vendor/service/orders/${tableOrder.id}/serve`, { token: serverToken, body: { item_ids: [cappuccino.id] } }));

  ok(await move(chefToken, food, 'accepted'));
  ok(await move(chefToken, food, 'ready'));
  ok(await move(ownerA, bakery, 'preparing'));
  res = ok(await move(ownerA, bakery, 'ready'));
  assert.equal(res.order_status, 'ready', 'every department done: the order is ready');

  const served = ok(await api('POST', `/vendor/service/orders/${tableOrder.id}/serve`, { token: serverToken, body: {} }));
  assert.equal(served.status, 'delivered');
  const guest = ok(await api('GET', `/tables/${tableA1.token}/orders/${tableOrder.id}`, { headers: { 'x-guest-key': guestKey } }));
  assert.equal(guest.order.status_label, 'Served');
  assert.ok(guest.order.departments.every((d) => d.status === 'ready'));
});

test('F. the cashier takes a partial then a full payment; the bill stays linked to its order', async () => {
  const { invoices } = ok(await api('GET', '/vendor/invoices?status=open', { token: cashierToken }));
  const id = invoices[0].id;
  // A server can see the bill but not take money.
  ok(await api('GET', `/vendor/invoices/${id}`, { token: serverToken }));
  assert.equal((await api('POST', `/vendor/invoices/${id}/payments`, { token: serverToken, body: { amount_rwf: 1000, method: 'cash' } })).status, 403);

  let invoice = ok(await api('POST', `/vendor/invoices/${id}/payments`, { token: cashierToken, body: { amount_rwf: 5000, method: 'cash' } }));
  assert.equal(invoice.status, 'partially_paid');
  assert.equal(invoice.balance_due_rwf, 10000);
  assert.equal((await api('POST', `/vendor/invoices/${id}/payments`, { token: cashierToken, body: { amount_rwf: 20000, method: 'cash' } })).status, 400, 'no overpayment');
  invoice = ok(await api('POST', `/vendor/invoices/${id}/payments`, { token: cashierToken, body: { amount_rwf: 10000, method: 'mobile_money', reference: 'MM123' } }));
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.is_open, false);
  assert.deepEqual(invoice.order_ids, [tableOrder.id]);
  const order = await Order.findById(tableOrder.id).lean();
  assert.equal(order.payment_status, 'paid');
  assert.equal(String(order.invoice_id), id);
});

test('F. "pay before preparation": departments wait until the bill is paid', async () => {
  ok(await api('PUT', '/vendor/operations', { token: ownerA, body: { payment_timing: 'before_preparation' } }));
  // Staff can't change the kitchen's rules.
  assert.equal((await api('PUT', '/vendor/operations', { token: cashierToken, body: { payment_timing: 'after_service' } })).status, 403);
  const placed = ok(await api('POST', `/tables/${tableA1.token}/orders`, { body: { items: [{ menu_item_id: dish.cappuccino, quantity: 1 }] } }), 201);
  const order = await Order.findById(placed.order.id).lean();
  const ticket = order.tickets[0];
  const blocked = await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${ticket._id}`, { token: baristaToken, body: { status: 'preparing' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PAYMENT_PENDING');
  const invoice = ok(await api('GET', `/vendor/invoices/${order.invoice_id}`, { token: cashierToken }));
  assert.equal(invoice.total_rwf, 2500, 'a new bill: the last one was paid and closed');
  ok(await api('POST', `/vendor/invoices/${invoice.id}/payments`, { token: cashierToken, body: { amount_rwf: 2500, method: 'cash' } }));
  ok(await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${ticket._id}`, { token: baristaToken, body: { status: 'preparing' } }));
  ok(await api('PUT', '/vendor/operations', { token: ownerA, body: { payment_timing: 'after_service' } }));
});

test('E. app delivery orders are split into tickets, leave together, and get a paid invoice', async () => {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.burger, quantity: 1 } });
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.cake, quantity: 2 } });
  const order = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { delivery_location: NEARBY_ADDRESS, ...MOBILE_MONEY } }));
  assert.equal(order.departments.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const saved = await Order.findById(order.id).lean();
  assert.ok(saved.invoice_id, 'invoice created when paid');
  const invoice = ok(await api('GET', `/vendor/invoices/${saved.invoice_id}`, { token: ownerA }));
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.total_rwf, order.total_rwf);
  assert.equal(invoice.accepts_payments, false);

  const food = saved.tickets.find((t) => String(t.department_id) === dept.food);
  const bakery = saved.tickets.find((t) => String(t.department_id) === dept.bakery);
  ok(await api('PATCH', `/vendor/kitchen/orders/${order.id}/tickets/${food._id}`, { token: chefToken, body: { status: 'ready' } }));
  // A delivery order can't be handed over while the bakery is still working.
  const early = await api('POST', `/vendor/service/orders/${order.id}/collect`, { token: ownerA, body: {} });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'ORDER_NOT_COMPLETE');
  const done = ok(await api('PATCH', `/vendor/kitchen/orders/${order.id}/tickets/${bakery._id}`, { token: ownerA, body: { status: 'ready' } }));
  assert.equal(done.order_status, 'ready');
  const vendorView = ok(await api('GET', `/vendor/orders/${order.id}`, { token: ownerA }));
  assert.equal(vendorView.tickets.length, 2);
});

test('the owner moving the whole order still works and brings the tickets along', async () => {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.water, quantity: 1 } });
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.cappuccino, quantity: 1 } });
  const order = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { fulfillment: 'pickup', ...MOBILE_MONEY } }));
  for (const status of ['accepted', 'preparing', 'ready']) ok(await api('PATCH', `/vendor/orders/${order.id}/status`, { token: ownerA, body: { status } }));
  const saved = await Order.findById(order.id).lean();
  assert.ok(saved.tickets.every((t) => t.status === 'ready'));
  assert.ok(saved.tickets.some((t) => t.department_id === null), 'dishes with no department go to the kitchen ticket');
  // A cashier lacks orders.update_status.
  const customer2 = await createCustomer();
  await api('POST', '/cart', { token: customer2.token, body: { menu_item_id: dish.water, quantity: 1 } });
  const order2 = ok(await api('POST', '/orders/checkout', { token: customer2.token, body: { fulfillment: 'pickup', ...MOBILE_MONEY } }));
  assert.equal((await api('PATCH', `/vendor/orders/${order2.id}/status`, { token: cashierToken, body: { status: 'accepted' } })).status, 403);
});

test('a customer cancelling an app order cancels its tickets and voids its invoice', async () => {
  const customer = await createCustomer();
  await api('POST', '/cart', { token: customer.token, body: { menu_item_id: dish.cake, quantity: 1 } });
  const order = ok(await api('POST', '/orders/checkout', { token: customer.token, body: { fulfillment: 'pickup', ...MOBILE_MONEY } }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  ok(await api('POST', `/orders/${order.id}/cancel`, { token: customer.token, body: { reason: 'Changed my mind' } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const saved = await Order.findById(order.id).lean();
  assert.ok(saved.tickets.every((t) => t.status === 'cancelled'));
  const invoice = ok(await api('GET', `/vendor/invoices/${saved.invoice_id}`, { token: ownerA }));
  assert.equal(invoice.status, 'void');
});

test('D. a deactivated table takes no orders, and a replaced QR code stops working', async () => {
  const t = ok(await api('POST', '/vendor/tables', { token: ownerA, body: { label: 'Patio 3' } }), 201);
  ok(await api('PATCH', `/vendor/tables/${t.id}`, { token: ownerA, body: { is_active: false } }));
  const refused = await api('POST', `/tables/${t.token}/orders`, { body: { items: [{ menu_item_id: dish.water }] } });
  assert.equal(refused.status, 409);
  const rotated = ok(await api('POST', `/vendor/tables/${t.id}/qr/rotate`, { token: ownerA }));
  assert.notEqual(rotated.token, t.token);
  assert.equal((await api('GET', `/tables/${t.token}`)).status, 404);
  // Dishes of another kitchen can't be ordered through this kitchen's table.
  const otherDish = ok(await api('POST', '/vendor/menu', { token: ownerB, body: { name: 'B dish', price_rwf: 100 } }), 201);
  const cross = await api('POST', `/tables/${tableA1.token}/orders`, { body: { items: [{ menu_item_id: otherDish.id }] } });
  assert.equal(cross.status, 409);
});

test('G. kitchens are isolated: staff, orders, invoices, stock and reports', async () => {
  const bStaff = ok(await api('POST', '/vendor/staff', { token: ownerB, body: { name: 'B admin', phone: '0788555010', is_admin: true } }), 201);
  const bAdmin = staffToken(B.vendor, bStaff.id);
  // A staff token pointing at another kitchen is refused outright.
  const forged = signToken({ sub: String(A.vendor._id), role: 'vendor', staff_id: bStaff.id });
  assert.equal((await api('GET', '/vendor/workspace', { token: forged })).status, 401);

  assert.equal(ok(await api('GET', '/vendor/staff', { token: bAdmin })).staff.length, 1);
  assert.equal(ok(await api('GET', '/vendor/invoices', { token: bAdmin })).invoices.length, 0);
  assert.equal((await api('GET', `/vendor/orders/${tableOrder.id}`, { token: bAdmin })).status, 404);
  assert.equal((await api('GET', `/vendor/invoices/${(await Order.findById(tableOrder.id)).invoice_id}`, { token: bAdmin })).status, 404);
  const report = ok(await api('GET', '/vendor/reports?period=daily', { token: bAdmin }));
  assert.equal(report.summary.orders_placed, 0);
});

test('stock: recipes deduct automatically when a ticket is ready, with low-stock tracking', async () => {
  ok(await api('PUT', '/vendor/operations', { token: ownerA, body: { inventory_auto_deduct: true } }));
  const milk = ok(await api('POST', '/vendor/inventory', { token: ownerA, body: { name: 'Milk', unit: 'L', quantity: 1, low_stock_threshold: 0.5, department_id: dept.coffee } }), 201);
  ok(await api('PUT', `/vendor/menu/${dish.cappuccino}/recipe`, { token: ownerA, body: { recipe: [{ inventory_item_id: milk.id, quantity: 0.2 }] } }));
  // The prep cook role has no stock permission at all.
  assert.equal((await api('GET', '/vendor/inventory', { token: chefToken })).status, 403);
  // A stock role limited to food sees no coffee stock.
  const stockRole = ok(await api('POST', '/vendor/roles', { token: ownerA, body: { name: 'Food stock', permissions: ['inventory.view'], department_ids: [dept.food] } }), 201);
  const keeper = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Food Stock Keeper', phone: '0788555030', role_ids: [stockRole.id] } }), 201);
  assert.equal(ok(await api('GET', '/vendor/inventory', { token: staffToken(A.vendor, keeper.id) })).items.length, 0);

  const placed = ok(await api('POST', `/tables/${tableA1.token}/orders`, { body: { items: [{ menu_item_id: dish.cappuccino, quantity: 3 }] } }), 201);
  const order = await Order.findById(placed.order.id).lean();
  ok(await api('PATCH', `/vendor/kitchen/orders/${order._id}/tickets/${order.tickets[0]._id}`, { token: baristaToken, body: { status: 'ready' } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stock = ok(await api('GET', '/vendor/inventory', { token: ownerA }));
  const after = stock.items.find((i) => i.id === milk.id);
  assert.equal(after.quantity, 0.4);
  assert.equal(after.is_low, true);
  const moves = ok(await api('GET', `/vendor/inventory/movements?item_id=${milk.id}`, { token: ownerA }));
  assert.equal(moves.movements[0].reason, 'order');
});

test('reports: daily, weekly, monthly and yearly, with department sales and plain highlights', async () => {
  for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
    const report = ok(await api('GET', `/vendor/reports?period=${period}`, { token: ownerA }));
    assert.equal(report.period.type, period);
    assert.ok(report.summary.orders_placed >= 4);
    assert.ok(report.highlights.length >= 1);
    const coffee = report.departments.find((d) => d.department_id === dept.coffee);
    assert.ok(coffee.sales_rwf >= 5000);
  }
  // A coffee manager sees coffee only, without the kitchen's money sections.
  const managerRole = ok(await api('POST', '/vendor/roles', { token: ownerA, body: { name: 'Coffee reports', permissions: ['reports.departments'], department_ids: [dept.coffee] } }), 201);
  const manager = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Coffee Manager', phone: '0788555020', role_ids: [managerRole.id] } }), 201);
  const scoped = ok(await api('GET', '/vendor/reports?period=daily', { token: staffToken(A.vendor, manager.id) }));
  assert.deepEqual(scoped.departments.map((d) => d.department_id), [dept.coffee]);
  assert.equal(scoped.payments, null);
  assert.equal(scoped.staff, null);

  const csv = await fetch(`${require('../helpers/testServer').baseUrl()}/vendor/reports/export?period=monthly`, { headers: { Authorization: `Bearer ${ownerA}` } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Departments/);

  // The schedule saves the reports of periods that ended.
  const reportService = require('../../src/services/kitchen/reportService');
  // As if it were tomorrow: today's report is due.
  await reportService.generateDue(new Date(Date.now() + 86400000));
  const history = ok(await api('GET', '/vendor/reports/history?period=daily', { token: ownerA }));
  assert.ok(history.reports.length >= 1);
});

test('staff sign in with a code to their own kitchen, and deactivation signs them out', async () => {
  const sent = ok(await api('POST', '/vendor/auth/send-otp', { body: { identifier: '0788555004' } }));
  const verified = ok(await api('POST', '/vendor/auth/verify-otp', { body: { identifier: '0788555004', code: sent.dev_otp } }));
  assert.equal(verified.vendor.id, String(A.vendor._id));
  assert.equal(verified.staff.name, 'Sam Server');
  assert.ok(verified.access.permissions['service.collect']);
  ok(await api('GET', '/vendor/service/board', { token: verified.token }));

  // Signing out everywhere ends the employee's sessions, not the owner's.
  ok(await api('POST', '/vendor/auth/logout-all', { token: verified.token }));
  assert.equal((await api('GET', '/vendor/workspace', { token: verified.token })).status, 401);
  ok(await api('GET', '/vendor/workspace', { token: ownerA }));

  const staffList = ok(await api('GET', '/vendor/staff', { token: ownerA })).staff;
  const sam = staffList.find((s) => s.name === 'Sam Server');
  ok(await api('PATCH', `/vendor/staff/${sam.id}/status`, { token: ownerA, body: { is_active: false } }));
  assert.equal((await api('GET', '/vendor/service/board', { token: serverToken })).status, 401);
  // A deactivated employee can't request a code either.
  assert.equal((await api('POST', '/vendor/auth/send-otp', { body: { identifier: '0788555004' } })).status, 404);
});

test('staff can also use the unified sign-in page, which opens their kitchen', async () => {
  const sent = ok(await api('POST', '/auth/login/send-otp', { body: { identifier: '0788555003' } }));
  assert.equal(sent.role, 'vendor');
  const verified = ok(await api('POST', '/auth/login/verify-otp', { body: { identifier: '0788555003', code: sent.dev_otp, role: 'vendor' } }));
  assert.equal(verified.vendor.id, String(A.vendor._id));
  assert.equal(verified.staff.name, 'Claude Cashier');
  assert.equal(verified.access.is_admin, false);
});

test('the administrator creates a username and password; the employee signs in with them', async () => {
  const roles = ok(await api('GET', '/vendor/roles', { token: ownerA })).roles;
  const waiter = roles.find((r) => r.template_key === 'server');
  // No phone or email at all: a username, and a password the server makes.
  const created = ok(await api('POST', '/vendor/staff', { token: ownerA, body: { name: 'Pat Waiter', username: 'Pat.Waiter', role_ids: [waiter.id] } }), 201);
  assert.equal(created.username, 'pat.waiter');
  assert.equal(created.credentials.username, 'pat.waiter');
  assert.equal(created.credentials.password.length, 10);
  // Shown once: reading the employee again never returns it.
  const again = ok(await api('GET', `/vendor/staff/${created.id}`, { token: ownerA }));
  assert.equal(again.credentials, undefined);
  assert.equal(again.has_password, true);

  assert.equal((await api('POST', '/vendor/auth/staff-login', { body: { username: 'pat.waiter', password: 'wrong-password' } })).status, 401);
  const signedIn = ok(await api('POST', '/vendor/auth/staff-login', { body: { username: 'PAT.WAITER', password: created.credentials.password } }));
  assert.equal(signedIn.vendor.id, String(A.vendor._id));
  assert.equal(signedIn.staff.username, 'pat.waiter');
  ok(await api('GET', '/vendor/service/board', { token: signedIn.token }));
  assert.equal((await api('GET', '/vendor/wallet', { token: signedIn.token })).status, 403);

  // The administrator chooses a password; the old one and old sessions stop working.
  const reset = ok(await api('PATCH', `/vendor/staff/${created.id}`, { token: ownerA, body: { password: 'Chosen-pass-1' } }));
  assert.equal(reset.credentials.password, 'Chosen-pass-1');
  assert.equal((await api('GET', '/vendor/workspace', { token: signedIn.token })).status, 401);
  assert.equal((await api('POST', '/vendor/auth/staff-login', { body: { username: 'pat.waiter', password: created.credentials.password } })).status, 401);
  const second = ok(await api('POST', '/vendor/auth/staff-login', { body: { username: 'pat.waiter', password: 'Chosen-pass-1' } }));
  // The employee changes their own password.
  ok(await api('POST', '/vendor/auth/change-password', { token: second.token, body: { current_password: 'Chosen-pass-1', new_password: 'Mine-now-2026' } }));
  ok(await api('POST', '/vendor/auth/staff-login', { body: { username: 'pat.waiter', password: 'Mine-now-2026' } }));

  // Usernames are unique across kitchens.
  assert.equal((await api('POST', '/vendor/staff', { token: ownerB, body: { name: 'Other Pat', username: 'pat.waiter' } })).status, 409);
});

test('a kitchen can show photos of its own printed menu', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c08a63' } }).png().toBuffer();
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'menu.png');
  form.append('caption', 'Breakfast menu');
  const res = await fetch(`${require('../helpers/testServer').baseUrl()}/vendor/menu/photos`, { method: 'POST', headers: { Authorization: `Bearer ${ownerA}` }, body: form });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0].caption, 'Breakfast menu');
  const storefront = ok(await api('GET', `/vendors/${A.vendor._id}`));
  assert.equal(storefront.menu_photos.length, 1);
  // A role without menu permissions can't add one.
  assert.equal((await fetch(`${require('../helpers/testServer').baseUrl()}/vendor/menu/photos`, { method: 'POST', headers: { Authorization: `Bearer ${cashierToken}` }, body: form })).status, 403);
  const removed = ok(await api('DELETE', `/vendor/menu/photos/${body.photos[0].id}`, { token: ownerA }));
  assert.equal(removed.photos.length, 0);
});

test('the activity log records who did what', async () => {
  const log = ok(await api('GET', '/vendor/activity?limit=100', { token: ownerA }));
  const actions = new Set(log.items.map((e) => e.action));
  for (const action of ['department.created', 'role.created', 'staff.created', 'table.created', 'ticket.ready', 'invoice.payment', 'staff.deactivated']) {
    assert.ok(actions.has(action), `${action} is logged`);
  }
  assert.ok(log.items.some((e) => e.actor.name === 'Claude Cashier' && e.action === 'invoice.payment'));
  await Vendor.updateOne({ _id: A.vendor._id }, { $set: { 'operations.inventory_auto_deduct': false } });
});

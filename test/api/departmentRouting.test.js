// A kitchen that started with no departments sorts its dishes in one step.
// An order of pilau, cake and coffee then goes to the kitchen, the baker and
// the barista separately, each seeing only their part, while the customer
// keeps one order and one bill.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');

const staffToken = (vendor, staffId) => signToken({ sub: String(vendor._id), role: 'vendor', staff_id: String(staffId) });
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

let K;
let owner;
const dish = {};
const token = {};
let table;
let order;

before(async () => {
  await start();
  K = await createKitchen({ name: 'One Room Kitchen' });
  owner = signToken({ sub: String(K.vendor._id), role: 'vendor' });
});
after(stop);

test('a kitchen with no departments: dishes, default roles and staff', async () => {
  for (const [key, name, price] of [['pilau', 'Pilau', 4000], ['cake', 'Cake', 2500], ['coffee', 'Coffee', 1500]]) {
    dish[key] = ok(await api('POST', '/vendor/menu', { token: owner, body: { name, price_rwf: price } }), 201).id;
  }
  const { roles } = ok(await api('GET', '/vendor/roles', { token: owner }));
  const role = (key) => roles.find((r) => r.template_key === key).id;
  for (const [key, phone] of [['chef', '0788600001'], ['baker', '0788600002'], ['barista', '0788600003'], ['kitchen_manager', '0788600004'], ['cashier', '0788600005']]) {
    const staff = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: `The ${key}`, phone, role_ids: [role(key)] } }), 201);
    token[key] = staffToken(K.vendor, staff.id);
  }
  table = ok(await api('POST', '/vendor/tables', { token: owner, body: { label: 'Table 1' } }), 201);
});

test('one-step setup creates the departments, sorts the dishes and limits the preparing roles', async () => {
  const bad = await api('POST', '/vendor/departments/setup', { token: owner, body: { departments: ['bakery'], dishes: [{ menu_item_id: dish.pilau, category: 'restaurant' }] } });
  assert.equal(bad.status, 400, 'a dish must go to a chosen department');
  assert.equal((await api('POST', '/vendor/departments/setup', { token: token.baker, body: { departments: ['bakery'] } })).status, 403);

  const result = ok(await api('POST', '/vendor/departments/setup', {
    token: owner,
    body: {
      departments: ['restaurant', 'bakery', 'coffee'],
      dishes: [
        { menu_item_id: dish.pilau, category: 'restaurant' },
        { menu_item_id: dish.cake, category: 'bakery' },
        { menu_item_id: dish.coffee, category: 'coffee' },
      ],
    },
  }));
  assert.deepEqual(result.departments.map((d) => d.name).sort(), ['Bakery', 'Coffee', 'Kitchen']);
  assert.ok(result.departments.every((d) => d.product_count === 1));
  assert.equal(result.unassigned_products, 0);

  const { roles } = ok(await api('GET', '/vendor/roles', { token: owner }));
  const deptOf = (category) => result.departments.find((d) => d.category === category).id;
  const linked = (key) => roles.find((r) => r.template_key === key).department_ids;
  assert.deepEqual(linked('chef'), [deptOf('restaurant')]);
  assert.deepEqual(linked('baker'), [deptOf('bakery')]);
  assert.deepEqual(linked('barista'), [deptOf('coffee')]);
  assert.deepEqual(linked('kitchen_manager'), [], 'the kitchen manager stays kitchen-wide');

  // Running it again reuses the departments; a role set by hand is left alone.
  const bartender = roles.find((r) => r.template_key === 'bartender');
  ok(await api('PATCH', `/vendor/roles/${bartender.id}`, { token: owner, body: { department_ids: [deptOf('coffee')] } }));
  const again = ok(await api('POST', '/vendor/departments/setup', { token: owner, body: { departments: ['bakery', 'bar'] } }));
  assert.equal(again.departments.length, 4);
  const after = ok(await api('GET', '/vendor/roles', { token: owner })).roles;
  assert.deepEqual(after.find((r) => r.id === bartender.id).department_ids, [deptOf('coffee')]);
});

test('pilau, cake and coffee: each goes to its own department, on one bill', async () => {
  const placed = ok(await api('POST', `/tables/${table.token}/orders`, {
    body: { items: [{ menu_item_id: dish.pilau, quantity: 1 }, { menu_item_id: dish.cake, quantity: 1 }, { menu_item_id: dish.coffee, quantity: 2 }] },
  }), 201);
  order = placed.order;
  assert.equal(order.total_rwf, 4000 + 2500 + 3000);
  assert.equal(order.departments.length, 3);

  const queue = async (who) => ok(await api('GET', '/vendor/kitchen/queue', { token: token[who] })).tickets.flatMap((t) => t.items.map((i) => i.name));
  assert.deepEqual(await queue('chef'), ['Pilau']);
  assert.deepEqual(await queue('baker'), ['Cake']);
  assert.deepEqual(await queue('barista'), ['Coffee']);

  // On the orders list too, each sees only their part, without the money.
  const seen = async (who) => ok(await api('GET', '/vendor/orders', { token: token[who] })).orders;
  const bakerView = (await seen('baker'))[0];
  assert.deepEqual(bakerView.items.map((i) => i.name), ['Cake']);
  assert.equal(bakerView.tickets.length, 1);
  assert.equal(bakerView.department_only, true);
  assert.equal(bakerView.total_amount_rwf, undefined);
  assert.deepEqual(bakerView.allowed_next_statuses, []);
  assert.deepEqual((await seen('chef'))[0].items.map((i) => i.name), ['Pilau']);
  const detail = ok(await api('GET', `/vendor/orders/${order.id}`, { token: token.barista }));
  assert.deepEqual(detail.items.map((i) => i.name), ['Coffee']);
  // They move their own ticket, not the whole order.
  assert.equal((await api('PATCH', `/vendor/orders/${order.id}/status`, { token: token.baker, body: { status: 'ready' } })).status, 403);

  // The manager, the cashier and the owner see the whole order; the bill is one.
  const managerView = (await seen('kitchen_manager'))[0];
  assert.equal(managerView.items.length, 3);
  assert.equal(managerView.total_amount_rwf, 9500);
  const ownerView = ok(await api('GET', '/vendor/orders', { token: owner })).orders[0];
  assert.equal(ownerView.items.length, 3);
  assert.equal(ownerView.total_amount_rwf, 9500);
  const invoices = ok(await api('GET', '/vendor/invoices', { token: token.cashier })).invoices;
  assert.equal(invoices.length, 1);
  assert.equal(ok(await api('GET', `/vendor/invoices/${invoices[0].id}`, { token: token.cashier })).total_rwf, 9500);
});

test('"Call the waiter" and "Bring the bill" go to the table\'s own server; the bill also to the cashier', async () => {
  const { roles } = ok(await api('GET', '/vendor/roles', { token: owner }));
  const serverRole = roles.find((r) => r.template_key === 'server').id;
  const amina = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Amina', phone: '0788600011', role_ids: [serverRole] } }), 201);
  const bosco = ok(await api('POST', '/vendor/staff', { token: owner, body: { name: 'Bosco', phone: '0788600012', role_ids: [serverRole] } }), 201);
  const aminaToken = staffToken(K.vendor, amina.id);
  const boscoToken = staffToken(K.vendor, bosco.id);
  const titles = async (t) => ok(await api('GET', '/vendor/inbox', { token: t })).items.map((n) => n.title);

  // Table 1 is Amina's: only she (and the cashier) hear about its bill.
  ok(await api('PATCH', `/vendor/tables/${table.id}`, { token: owner, body: { assigned_staff_id: amina.id } }));
  ok(await api('POST', `/tables/${table.token}/requests`, { body: { kind: 'request_bill' } }), 201);
  assert.ok((await titles(aminaToken)).includes('Table 1: Bring the bill'));
  assert.ok(!(await titles(boscoToken)).includes('Table 1: Bring the bill'));
  assert.ok((await titles(token.cashier)).includes('Table 1: Bring the bill'));

  // A table nobody looks after: every server hears, and the cashier.
  const table2 = ok(await api('POST', '/vendor/tables', { token: owner, body: { label: 'Table 2' } }), 201);
  ok(await api('POST', `/tables/${table2.token}/requests`, { body: { kind: 'request_bill' } }), 201);
  assert.ok((await titles(boscoToken)).includes('Table 2: Bring the bill'));
  assert.ok((await titles(aminaToken)).includes('Table 2: Bring the bill'));
  assert.ok((await titles(token.cashier)).includes('Table 2: Bring the bill'));

  // "Call the waiter": the table's server only (no cashier); every server when it has none.
  ok(await api('POST', `/tables/${table.token}/requests`, { body: { kind: 'call_waiter' } }), 201);
  assert.ok((await titles(aminaToken)).includes('Table 1: Call the waiter'));
  assert.ok(!(await titles(boscoToken)).includes('Table 1: Call the waiter'));
  assert.ok(!(await titles(token.cashier)).includes('Table 1: Call the waiter'));
  ok(await api('POST', `/tables/${table2.token}/requests`, { body: { kind: 'call_waiter' } }), 201);
  assert.ok((await titles(boscoToken)).includes('Table 2: Call the waiter'));
  assert.ok((await titles(aminaToken)).includes('Table 2: Call the waiter'));
});

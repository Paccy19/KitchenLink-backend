// The restaurant floor end to end: seating and table visits, servers taking
// orders, takeaway and leftovers at the packing station, closing a table,
// the kitchen's own deliveries, reservations with deposits and pre-orders,
// and who may (and may not) do each of these.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen, createCustomer } = require('../helpers/testServer');
const { signToken } = require('../../src/utils/jwt');
const { Order, Invoice, Vendor, Reservation, TableSession } = require('../../src/models');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};
const tokenFor = (vendor, staffId) => signToken({ sub: String(vendor._id), role: 'vendor', ...(staffId ? { staff_id: String(staffId) } : {}) });

let K;
let owner;
const dish = {};
const tables = {};
const staff = {};
let phoneSeq = 0;

async function employee(name, permissions) {
  phoneSeq += 1;
  const role = ok(await api('POST', '/vendor/roles', { token: owner, body: { name: `${name} role`, permissions } }), 201);
  const s = ok(await api('POST', '/vendor/staff', { token: owner, body: { name, phone: `07887000${String(phoneSeq).padStart(2, '0')}`, role_ids: [role.id] } }), 201);
  return { id: s.id, token: tokenFor(K.vendor, s.id) };
}

/** Moves every ticket of an order to ready (the chef). */
async function cookAll(orderId) {
  const order = await Order.findById(orderId).lean();
  for (const t of order.tickets) ok(await api('PATCH', `/vendor/kitchen/orders/${orderId}/tickets/${t._id}`, { token: staff.chef.token, body: { status: 'ready' } }));
}

before(async () => {
  await start();
  K = await createKitchen({ name: 'Floor Kitchen' });
  owner = tokenFor(K.vendor);
  for (const [key, name, price] of [['brochette', 'Brochette', 4000], ['fries', 'Fries', 2000], ['juice', 'Juice', 1500]]) {
    dish[key] = ok(await api('POST', '/vendor/menu', { token: owner, body: { name, price_rwf: price } }), 201).id;
  }
  for (const [label, capacity] of [['A1', 2], ['A2', 4], ['A3', 6], ['A4', 4]]) tables[label] = ok(await api('POST', '/vendor/tables', { token: owner, body: { label, capacity } }), 201);
  staff.host = await employee('Hope Host', ['tables.seat', 'tables.waitlist', 'tables.view', 'tables.transfer_sessions', 'service.assign_servers', 'reservations.view', 'reservations.check_in', 'reservations.manage_sessions']);
  staff.server = await employee('Sam Server', ['service.view_assigned', 'service.order_for_guests', 'service.request_packing', 'service.serve', 'service.view_ready', 'service.collect', 'tables.sessions_view']);
  staff.server2 = await employee('Sue Server', ['service.view_assigned', 'service.order_for_guests']);
  staff.chef = await employee('Chris Chef', ['kitchen.view_queue', 'kitchen.accept_tasks', 'kitchen.start_preparation', 'kitchen.mark_ready', 'kitchen.flag_issues']);
  staff.packer = await employee('Pat Packer', ['packing.view', 'packing.pack', 'packing.handover', 'packing.report_issue']);
  staff.cashier = await employee('Cash Cashier', ['invoices.view', 'invoices.process_payment', 'tables.close_sessions']);
  staff.manager = await employee('Max Manager', ['tables.close_sessions', 'tables.session_override', 'tables.sessions_view']);
  staff.coordinator = await employee('Dora Dispatch', ['delivery.view_orders', 'delivery.assign_workers', 'delivery.view_locations', 'delivery.change_assignments']);
  staff.driver = await employee('Dan Driver', ['delivery.drive']);
  staff.reception = await employee('Rita Reservations', ['reservations.view', 'reservations.create', 'reservations.confirm', 'reservations.deposits', 'reservations.preorders', 'reservations.cancel', 'reservations.check_in', 'reservations.manage_sessions', 'reservations.assign_tables']);
});
after(stop);

test('dine-in: seat from the waiting list, server orders, takeaway and leftovers, pay, close', async () => {
  const waiting = ok(await api('POST', '/vendor/waitlist', { token: staff.host.token, body: { name: 'Uwase party', party_size: 3, quoted_minutes: 10 } }), 201);
  // A2 seats 4: seating 5 needs a confirmation.
  const tooMany = await api('POST', '/vendor/table-sessions', { token: staff.host.token, body: { table_id: tables.A2.id, guest_count: 5 } });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, 'TABLE_TOO_SMALL');
  const session = ok(await api('POST', '/vendor/table-sessions', { token: staff.host.token, body: { table_id: tables.A2.id, guest_count: 3, waitlist_id: waiting.id, server_id: staff.server.id } }), 201);
  assert.equal(session.status, 'open');
  assert.equal(session.server.name, 'Sam Server');
  assert.equal(session.customer_name, 'Uwase party');
  // The table is now occupied; seating someone else there is refused.
  assert.equal((await api('POST', '/vendor/table-sessions', { token: staff.host.token, body: { table_id: tables.A2.id, guest_count: 2 } })).body.error.code, 'TABLE_OCCUPIED');
  const floor = ok(await api('GET', '/vendor/floor', { token: staff.host.token }));
  assert.equal(floor.tables.find((t) => t.label === 'A2').state, 'occupied');
  assert.equal(floor.waitlist.length, 0, 'the party left the waiting list');

  // The server takes the order: one juice to take away (a new item: billed).
  const taken = ok(await api('POST', `/vendor/table-sessions/${session.id}/orders`, { token: staff.server.token, body: { items: [{ menu_item_id: dish.brochette, quantity: 2 }, { menu_item_id: dish.juice, quantity: 1, takeaway: true }] } }), 201);
  assert.equal(taken.order.total_rwf, 9500, 'priced by the server');
  assert.equal(taken.session.status, 'active');
  // Another server can't order on this table.
  assert.equal((await api('POST', `/vendor/table-sessions/${session.id}/orders`, { token: staff.server2.token, body: { items: [{ menu_item_id: dish.fries, quantity: 1 }] } })).status, 403);
  // A QR order at the same table joins the same visit and the same bill.
  const qr = ok(await api('POST', `/tables/${tables.A2.token}/orders`, { body: { items: [{ menu_item_id: dish.fries, quantity: 1 }] } }), 201);
  const qrOrder = await Order.findById(qr.order.id).lean();
  assert.equal(String(qrOrder.table_session_id), session.id);

  // The chef flags a delay; the problem shows on the ticket.
  const order = await Order.findById(taken.order.id).lean();
  const flagged = ok(await api('POST', `/vendor/kitchen/orders/${order._id}/tickets/${order.tickets[0]._id}/flags`, { token: staff.chef.token, body: { kind: 'delayed', note: 'Grill heating' } }), 201);
  assert.equal(flagged.ticket.open_flags, 1);
  await cookAll(order._id);
  await cookAll(qrOrder._id);

  // Serving skips the takeaway juice; it goes to the packing station.
  const served = ok(await api('POST', `/vendor/service/orders/${order._id}/serve`, { token: staff.server.token, body: {} }));
  assert.notEqual(served.status, 'delivered', 'the juice is still to hand over');
  const packing = ok(await api('GET', '/vendor/packing', { token: staff.packer.token }));
  const juiceTask = packing.tasks.find((t) => t.kind === 'takeaway');
  assert.ok(juiceTask);
  ok(await api('POST', `/vendor/packing/${juiceTask.id}/pack`, { token: staff.packer.token }));
  ok(await api('POST', `/vendor/packing/${juiceTask.id}/handover`, { token: staff.packer.token }));
  assert.equal((await Order.findById(order._id).lean()).status, 'delivered', 'served + handed over = complete');
  ok(await api('POST', `/vendor/service/orders/${qrOrder._id}/serve`, { token: staff.server.token, body: {} }));

  // Leftovers: packed for free (the bill does not change).
  const before = await Invoice.findOne({ session_id: session.id }).lean();
  const leftovers = ok(await api('POST', `/vendor/orders/${order._id}/leftovers`, { token: staff.server.token, body: { instructions: 'Separate boxes' } }), 201);
  assert.equal(leftovers.kind, 'leftover');
  assert.equal((await Invoice.findOne({ session_id: session.id }).lean()).total_rwf, before.total_rwf, 'no new charge for leftovers');
  assert.equal(before.total_rwf, 11500, 'one bill for the whole visit');

  // Closing waits for the leftovers and the payment.
  const early = await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.cashier.token, body: {} });
  assert.equal(early.status, 409);
  assert.deepEqual(early.body.error.details.blockers.sort(), ['packing_open', 'unpaid']);
  ok(await api('POST', `/vendor/packing/${leftovers.id}/pack`, { token: staff.packer.token }));
  ok(await api('POST', `/vendor/packing/${leftovers.id}/handover`, { token: staff.server.token }));
  ok(await api('POST', `/vendor/invoices/${before._id}/payments`, { token: staff.cashier.token, body: { amount_rwf: 11500, idempotency_key: 'test-payment-key-0005', method: 'cash' } }));
  const closed = ok(await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.cashier.token, body: {} }));
  assert.equal(closed.status, 'closed');
  assert.equal((await Order.findById(order._id).lean()).payment_status, 'paid');
  const after = ok(await api('GET', '/vendor/floor', { token: staff.host.token }));
  assert.equal(after.tables.find((t) => t.label === 'A2').state, 'available');
});

test('dine-in: move guests to another table, convert to takeaway, manager override', async () => {
  const session = ok(await api('POST', '/vendor/table-sessions', { token: staff.host.token, body: { table_id: tables.A1.id, guest_count: 2, server_id: staff.server.id } }), 201);
  const taken = ok(await api('POST', `/vendor/table-sessions/${session.id}/orders`, { token: staff.server.token, body: { items: [{ menu_item_id: dish.fries, quantity: 2 }] } }), 201);
  const moved = ok(await api('POST', `/vendor/table-sessions/${session.id}/transfer`, { token: staff.host.token, body: { table_id: tables.A3.id } }));
  assert.equal(moved.table.label, 'A3');
  assert.equal((await Order.findById(taken.order.id).lean()).table.label, 'A3', 'the order follows');
  assert.equal((await Invoice.findOne({ session_id: session.id }).lean()).table_label, 'A3', 'the bill follows');
  // The guests take everything away: same items, same bill, nothing charged twice.
  const bill = await Invoice.findOne({ session_id: session.id }).lean();
  ok(await api('POST', `/vendor/orders/${taken.order.id}/takeaway`, { token: staff.server.token, body: {} }), 201);
  assert.equal((await Invoice.findById(bill._id).lean()).total_rwf, bill.total_rwf);
  // The server can't close it; a cashier can't override; a manager can, with a reason.
  assert.equal((await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.server.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.cashier.token, body: { override: true, reason: 'x' } })).status, 403);
  assert.equal((await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.manager.token, body: { override: true } })).status, 400, 'a reason is required');
  const closed = ok(await api('POST', `/vendor/table-sessions/${session.id}/close`, { token: staff.manager.token, body: { override: true, reason: 'Guests left, will pay tomorrow' } }));
  assert.equal(closed.status, 'closed');
  assert.ok(closed.close_exceptions.some((e) => e.includes('Guests left')));
  // The unpaid bill is still outstanding (never marked paid).
  const left = await Invoice.findById(bill._id).lean();
  assert.equal(left.status, 'unpaid');
  assert.equal(left.is_open, false);
});

test('delivery: packed before dispatch, driver lifecycle, the customer code completes it', async () => {
  await Vendor.updateOne({ _id: K.vendor._id }, { $set: { 'operations.require_packing': true } });
  const customer = await createCustomer();
  const order = await Order.create({
    order_number: 'OFK-TEST-DELIVER',
    customer_id: customer.customer.id,
    vendor_id: K.vendor._id,
    items: [{ menu_item_id: dish.brochette, name: 'Brochette', price_rwf: 4000, quantity: 1, subtotal_rwf: 4000 }],
    subtotal_rwf: 4000,
    delivery_fee_rwf: 2000,
    total_rwf: 6000,
    fulfillment: 'vendor_delivery',
    delivery_location: { address: 'Far road 12', latitude: -2.5, longitude: 29.6 },
    payment_method: 'mobile_money',
    payment_status: 'paid',
    status: 'preparing',
  });
  ok(await api('PATCH', `/vendor/orders/${order._id}/status`, { token: owner, body: { status: 'ready' } }));
  ok(await api('PUT', `/vendor/orders/${order._id}/courier`, { token: staff.coordinator.token, body: { staff_id: staff.driver.id } }));
  // The driver sees only their own delivery, without the money.
  const mine = ok(await api('GET', '/vendor/deliveries', { token: staff.driver.token }));
  assert.equal(mine.coordinator, false);
  assert.deepEqual(mine.deliveries.map((d) => d.id), [String(order._id)]);
  assert.equal(mine.deliveries[0].total_rwf, undefined);
  assert.equal(mine.deliveries[0].packing, 'requested');
  // Not packed yet: the driver can't take it.
  const early = await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'collected' } });
  assert.equal(early.body.error.code, 'NOT_PACKED');
  const task = ok(await api('GET', '/vendor/packing', { token: staff.packer.token })).tasks.find((t) => t.order_id === String(order._id));
  ok(await api('POST', `/vendor/packing/${task.id}/pack`, { token: staff.packer.token }));
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'acknowledged' } }));
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'collected' } }));
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'in_transit' } }));
  // A failed attempt needs a note, then the driver tries again.
  assert.equal((await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'customer_unavailable' } })).status, 400);
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'customer_unavailable', note: 'No answer at the gate' } }));
  ok(await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'in_transit' } }));
  // Can't skip to delivered: only the customer's code does that.
  assert.equal((await api('PATCH', `/vendor/orders/${order._id}/courier/status`, { token: staff.driver.token, body: { status: 'delivered' } })).status, 409);
  const tracking = ok(await api('GET', `/orders/${order._id}/track`, { token: customer.token }));
  assert.equal(tracking.kitchen_courier.status, 'in_transit');
  assert.equal(tracking.packing.status, 'packed');
  const code = (await Order.findById(order._id).select('+pickup_code').lean()).pickup_code;
  ok(await api('POST', `/vendor/orders/${order._id}/collect`, { token: staff.driver.token, body: { pickup_code: code } }));
  const done = await Order.findById(order._id).lean();
  assert.equal(done.status, 'delivered');
  assert.equal(done.kitchen_courier.status, 'delivered');
  assert.equal(done.kitchen_courier.attempts.length, 2);
  const board = ok(await api('GET', '/vendor/deliveries', { token: staff.coordinator.token }));
  assert.equal(board.coordinator, true);
  assert.ok(board.couriers.some((c) => c.name === 'Dan Driver'));
  await Vendor.updateOne({ _id: K.vendor._id }, { $set: { 'operations.require_packing': false } });
});

test('reservations: online booking, confirm, deposit, pre-order, arrive, seat, deposit on the bill', async () => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const slots = ok(await api('GET', `/bookings/kitchens/${K.vendor._id}/slots?date=${day}&party_size=4`));
  const slot = slots.slots.find((s) => s.available);
  assert.ok(slot, 'free times are offered');
  // Bigger than the kitchen takes online:
  assert.equal((await api('POST', `/bookings/kitchens/${K.vendor._id}`, { body: { name: 'Huge', phone: '0788111222', party_size: 40, starts_at: slot.starts_at } })).status, 400);
  const booked = ok(await api('POST', `/bookings/kitchens/${K.vendor._id}`, { body: { name: 'Keza Family', phone: '0788111222', party_size: 4, starts_at: slot.starts_at, special_requests: 'Window seat', preorder_items: [{ menu_item_id: dish.brochette, quantity: 2 }] } }), 201);
  assert.equal(booked.status, 'pending');
  assert.ok(booked.token);
  // The guest views the booking with the private token only.
  assert.equal((await api('GET', '/bookings/manage', { headers: { 'X-Booking-Token': 'not-the-right-token-at-all-123' } })).status, 404);
  const viewed = ok(await api('GET', '/bookings/manage', { headers: { 'X-Booking-Token': booked.token } }));
  assert.equal(viewed.status, 'pending');
  assert.equal(viewed.phone, '0788111222');

  ok(await api('POST', `/vendor/reservations/${booked.id}/confirm`, { token: staff.reception.token }));
  ok(await api('PATCH', `/vendor/reservations/${booked.id}`, { token: staff.reception.token, body: { table_id: tables.A4.id } }));
  const deposit = ok(await api('POST', `/vendor/reservations/${booked.id}/deposit`, { token: staff.reception.token, body: { amount_rwf: 5000, method: 'mobile_money', reference: 'MM-1' } }));
  assert.equal(deposit.deposit.status, 'paid');
  // Pre-ordered dishes are not sent to the kitchen before the guests come.
  assert.equal(await Order.countDocuments({ reservation_id: booked.id }), 0);
  // The booking is in two days: guests "arrive" early in the test.
  await Reservation.updateOne({ _id: booked.id }, { $set: { starts_at: new Date(Date.now() + 10 * 60000), ends_at: new Date(Date.now() + 100 * 60000) } });
  ok(await api('POST', `/vendor/reservations/${booked.id}/arrive`, { token: staff.host.token }));
  const seated = ok(await api('POST', `/vendor/reservations/${booked.id}/seat`, { token: staff.host.token, body: { server_id: staff.server.id } }));
  assert.equal(seated.status, 'seated');
  const session = await TableSession.findOne({ reservation_id: booked.id }).lean();
  assert.equal(session.table_label, 'A4');
  assert.equal(session.source, 'reservation');
  const pre = await Order.findOne({ reservation_id: booked.id }).lean();
  assert.ok(pre, 'the pre-order went to the kitchen at seating');
  assert.equal(String(pre.table_session_id), String(session._id));
  const bill = await Invoice.findOne({ session_id: session._id }).lean();
  assert.equal(bill.total_rwf, 8000);
  assert.equal(bill.amount_paid_rwf, 5000, 'the deposit counts on the bill');
  assert.equal(bill.payments[0].method, 'deposit');
  const after = await Reservation.findById(booked.id).lean();
  assert.equal(after.deposit.status, 'applied');
  // More orders don't use the deposit again.
  ok(await api('POST', `/vendor/table-sessions/${session._id}/orders`, { token: staff.server.token, body: { items: [{ menu_item_id: dish.juice, quantity: 2 }] } }), 201);
  const bill2 = await Invoice.findById(bill._id).lean();
  assert.equal(bill2.amount_paid_rwf, 5000);
  assert.equal(bill2.total_rwf, 11000);
});

test('reservations: deposit policies on cancelling, no-shows, buffer between bookings', async () => {
  const at = new Date(Date.now() + 3 * 3600000);
  const make = async (name, when, tableId) => ok(await api('POST', '/vendor/reservations', { token: staff.reception.token, body: { name, party_size: 2, starts_at: when.toISOString(), table_id: tableId } }), 201);
  const late = await make('Late Canceller', at, tables.A1.id);
  // Within the buffer of the first booking (90 minutes + 15 minutes buffer): refused.
  assert.equal((await api('POST', '/vendor/reservations', { token: staff.reception.token, body: { name: 'Too close', party_size: 2, starts_at: new Date(at.getTime() + 100 * 60000).toISOString(), table_id: tables.A1.id } })).body.error.code, 'TABLE_BOOKED');
  ok(await api('POST', `/vendor/reservations/${late.id}/deposit`, { token: staff.reception.token, body: { amount_rwf: 2000, method: 'cash' } }));
  // Cancelled 3 hours before (the notice period is 24 hours): the deposit is kept.
  const cancelled = ok(await api('POST', `/vendor/reservations/${late.id}/cancel`, { token: staff.reception.token, body: { reason: 'Changed plans' } }));
  assert.equal(cancelled.deposit.status, 'forfeited');
  // A no-show can only be marked once the time has come.
  const future = await make('Future Guest', new Date(Date.now() + 5 * 86400000), tables.A3.id);
  assert.equal((await api('POST', `/vendor/reservations/${future.id}/no-show`, { token: staff.reception.token })).body.error.code, 'TOO_EARLY');
  await Reservation.updateOne({ _id: future.id }, { $set: { starts_at: new Date(Date.now() - 30 * 60000) } });
  const noShow = ok(await api('POST', `/vendor/reservations/${future.id}/no-show`, { token: staff.reception.token }));
  assert.equal(noShow.status, 'no_show');
  // A finished booking can't be seated.
  assert.equal((await api('POST', `/vendor/reservations/${future.id}/seat`, { token: staff.host.token, body: { table_id: tables.A3.id } })).body.error.code, 'INVALID_RESERVATION_STATUS');
});

test('security: roles see and do only their part', async () => {
  // A driver has no floor, packing or bills.
  for (const path of ['/vendor/floor', '/vendor/packing', '/vendor/invoices', '/vendor/table-sessions']) {
    assert.equal((await api('GET', path, { token: staff.driver.token })).status, 403, path);
  }
  // A packer can't seat guests or take orders.
  assert.equal((await api('POST', '/vendor/table-sessions', { token: staff.packer.token, body: { table_id: tables.A1.id, guest_count: 2 } })).status, 403);
  // A server with "assigned" only sees their own tables.
  const s = ok(await api('POST', '/vendor/table-sessions', { token: staff.host.token, body: { table_id: tables.A1.id, guest_count: 2, server_id: staff.server.id } }), 201);
  const other = ok(await api('GET', '/vendor/table-sessions', { token: staff.server2.token }));
  assert.ok(!other.sessions.some((x) => x.id === s.id));
  assert.equal((await api('GET', `/vendor/table-sessions/${s.id}`, { token: staff.server2.token })).status, 403);
  // Guests have no access to staff endpoints.
  assert.equal((await api('GET', '/vendor/floor')).status, 401);
  // Another kitchen can't see this one's visits.
  const other2 = await createKitchen({ name: 'Other Kitchen' });
  assert.equal((await api('GET', `/vendor/table-sessions/${s.id}`, { token: tokenFor(other2.vendor) })).status, 404);
  // Prices come from the server, not the request.
  const taken = ok(await api('POST', `/vendor/table-sessions/${s.id}/orders`, { token: staff.server.token, body: { items: [{ menu_item_id: dish.juice, quantity: 1, price_rwf: 1 }] } }), 201);
  assert.equal(taken.order.total_rwf, 1500);
  // The kitchen's own settings: only rule-makers change them.
  assert.equal((await api('PUT', '/vendor/operations', { token: staff.host.token, body: { require_packing: true } })).status, 403);
  const settings = ok(await api('PUT', '/vendor/operations', { token: owner, body: { session_close: { requests_resolved: true }, reservations: { buffer_minutes: 30, max_party: 8 } } }));
  assert.equal(settings.session_close.requests_resolved, true);
  assert.equal(settings.reservations.max_party, 8);
});

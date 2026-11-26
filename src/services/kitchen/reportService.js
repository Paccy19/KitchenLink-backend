const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const config = require('../../config');
const { Order, Invoice, StockMovement, InventoryItem, MenuItem, KitchenStaff, KitchenActivity, KitchenReport, Vendor, Refund, Reservation, TableSession, PackingTask, DiningTable } = require('../../models');
const notificationService = require('../notificationService');
const departmentService = require('./departmentService');

const { ObjectId } = mongoose.Types;
const OFFSET_MS = (config.vendor.timezoneOffsetHours ?? 2) * 3600 * 1000; // Rwanda time (UTC+2)
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const PERIOD_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: 'Custom' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rwf = (n) => `RWF ${Math.round(n || 0).toLocaleString('en-US')}`;
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

// ------------------------------------------------------------ periods (Rwanda time)

const local = (date) => new Date(date.getTime() + OFFSET_MS); // read with getUTC*
const fromLocal = (y, m, d) => new Date(Date.UTC(y, m, d) - OFFSET_MS);

/** The period of `type` containing `at`: { type, start, end, label }. */
function periodContaining(type, at = new Date()) {
  const l = local(at);
  const y = l.getUTCFullYear();
  const m = l.getUTCMonth();
  const d = l.getUTCDate();
  let start;
  let end;
  if (type === 'daily') {
    start = fromLocal(y, m, d);
    end = fromLocal(y, m, d + 1);
  } else if (type === 'weekly') {
    const weekday = (l.getUTCDay() + 6) % 7; // Monday = 0
    start = fromLocal(y, m, d - weekday);
    end = fromLocal(y, m, d - weekday + 7);
  } else if (type === 'monthly') {
    start = fromLocal(y, m, 1);
    end = fromLocal(y, m + 1, 1);
  } else if (type === 'yearly') {
    start = fromLocal(y, 0, 1);
    end = fromLocal(y + 1, 0, 1);
  } else {
    throw ApiError.badRequest('period must be daily, weekly, monthly or yearly.', { period: `expected one of: ${PERIODS.join(', ')}` });
  }
  return { type, start, end, label: periodLabel(type, start, end) };
}

function periodLabel(type, start, end) {
  const s = local(start);
  const e = local(new Date(end.getTime() - 1));
  const day = (x) => `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)} ${x.getUTCFullYear()}`;
  if (type === 'daily') return day(s);
  if (type === 'weekly') return `Week of ${day(s)} – ${day(e)}`;
  if (type === 'monthly') return `${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`;
  if (type === 'yearly') return String(s.getUTCFullYear());
  return `${day(s)} – ${day(e)}`;
}

const previousPeriod = (period) => periodContaining(period.type, new Date(period.start.getTime() - 1));

function parsePeriod(query = {}) {
  const type = String(query.period || 'daily');
  if (type === 'custom') {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 400 * 86400000) {
      throw ApiError.badRequest('Pick a start and end date (at most 400 days apart).', { from: 'invalid range' });
    }
    const start = new Date(from);
    const end = new Date(to);
    return { type: 'custom', start, end, label: periodLabel('custom', start, end) };
  }
  if (query.date && Number.isNaN(Date.parse(query.date))) throw ApiError.badRequest('date is not a valid date.', { date: 'expected YYYY-MM-DD' });
  // A date picks the day/week/month/year it falls in (read as Rwanda midnight).
  const at = query.date ? new Date(Date.parse(`${String(query.date).slice(0, 10)}T12:00:00Z`)) : new Date();
  return periodContaining(type, at);
}

// ------------------------------------------------------------ the report itself

const isSale = (order) => order.status !== 'cancelled' && (order.payment_status === 'paid' || order.payment_method === 'in_person');
const minutesBetween = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 60000) : null);
const avg = (list) => (list.length ? Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10 : null);

/**
 * The floor and the road in one period: table visits and how much each
 * table was used, reservations and who came, how long food waited to be
 * served, packing, and the kitchen's own deliveries.
 */
async function operationsSection(vid, period, orders) {
  const range = { $gte: period.start, $lt: period.end };
  const [sessions, reservations, packing, tables] = await Promise.all([
    TableSession.find({ vendor_id: vid, started_at: { $lt: period.end }, $or: [{ closed_at: null }, { closed_at: { $gte: period.start } }] }).select('table_id table_label guest_count started_at closed_at close_exceptions').lean(),
    Reservation.find({ vendor_id: vid, starts_at: range }).select('status source party_size deposit').lean(),
    PackingTask.find({ vendor_id: vid, created_at: range }).select('kind status created_at packed_at handed_over_at').lean(),
    DiningTable.find({ vendor_id: vid, deleted_at: null }).select('label').lean(),
  ]);
  const periodMinutes = Math.max(1, (Math.min(period.end, new Date()) - period.start) / 60000);
  const perTable = new Map(tables.map((t) => [String(t._id), { label: t.label, visits: 0, guests: 0, minutes: 0 }]));
  const visitMinutes = [];
  for (const sn of sessions) {
    const from = Math.max(new Date(sn.started_at), period.start);
    const to = Math.min(sn.closed_at ? new Date(sn.closed_at) : new Date(), period.end);
    const minutes = Math.max(0, (to - from) / 60000);
    const row = perTable.get(String(sn.table_id)) || { label: sn.table_label, visits: 0, guests: 0, minutes: 0 };
    row.visits += 1;
    row.guests += sn.guest_count || 0;
    row.minutes += minutes;
    perTable.set(String(sn.table_id), row);
    if (sn.closed_at) visitMinutes.push(minutesBetween(sn.started_at, sn.closed_at));
  }
  const tableUse = [...perTable.values()]
    .map((t) => ({ label: t.label, visits: t.visits, guests: t.guests, hours_used: Math.round((t.minutes / 60) * 10) / 10, utilization_percent: Math.round((t.minutes / periodMinutes) * 100) }))
    .sort((a, b) => b.hours_used - a.hours_used);

  const byStatus = {};
  for (const r of reservations) {
    const st = r.status === 'booked' ? 'confirmed' : r.status;
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  const came = (byStatus.seated || 0) + (byStatus.completed || 0);
  const expected = came + (byStatus.no_show || 0);
  const deposits = { paid_rwf: 0, applied_rwf: 0, kept_rwf: 0, to_return_rwf: 0 };
  for (const r of reservations) {
    const d = r.deposit || {};
    deposits.paid_rwf += d.paid_rwf || 0;
    deposits.applied_rwf += d.applied_rwf || 0;
    if (d.status === 'forfeited') deposits.kept_rwf += (d.paid_rwf || 0) - (d.applied_rwf || 0);
    if (d.status === 'refunded') deposits.to_return_rwf += (d.paid_rwf || 0) - (d.applied_rwf || 0);
  }

  // Ready at the counter -> served at the table.
  const waitToServe = [];
  const courierMinutes = [];
  let failedAttempts = 0;
  for (const o of orders) {
    for (const item of o.items || []) {
      const ticket = (o.tickets || []).find((t) => String(t._id) === String(item.ticket_id));
      if (item.served_at && ticket?.ready_at) waitToServe.push(minutesBetween(ticket.ready_at, item.served_at));
    }
    if (o.kitchen_courier) {
      failedAttempts += (o.kitchen_courier.attempts || []).filter((a) => a.outcome !== 'delivered').length;
      if (o.status === 'delivered' && o.completed_at) courierMinutes.push(minutesBetween(o.kitchen_courier.assigned_at, o.completed_at));
    }
  }
  const packWait = packing.filter((t) => t.packed_at).map((t) => minutesBetween(t.created_at, t.packed_at));
  return {
    floor: {
      visits: sessions.length,
      guests: sessions.reduce((n, sn) => n + (sn.guest_count || 0), 0),
      avg_visit_minutes: avg(visitMinutes.filter((m) => m !== null)),
      closed_with_override: sessions.filter((sn) => (sn.close_exceptions || []).length).length,
      tables: tableUse,
    },
    reservations: {
      total: reservations.length,
      online: reservations.filter((r) => r.source === 'online').length,
      by_status: byStatus,
      guests_booked: reservations.reduce((n, r) => n + r.party_size, 0),
      attendance_percent: expected ? Math.round((came / expected) * 100) : null,
      deposits,
    },
    service: {
      avg_wait_to_serve_minutes: avg(waitToServe.filter((m) => m !== null)),
      packing_requests: packing.length,
      leftovers_packed: packing.filter((t) => t.kind === 'leftover' && t.status !== 'cancelled').length,
      avg_packing_minutes: avg(packWait.filter((m) => m !== null)),
    },
    deliveries: {
      kitchen_deliveries: orders.filter((o) => o.kitchen_courier).length,
      delivered: orders.filter((o) => o.kitchen_courier && o.status === 'delivered').length,
      failed_attempts: failedAttempts,
      avg_delivery_minutes: avg(courierMinutes.filter((m) => m !== null)),
    },
  };
}

/**
 * Everything that happened in a kitchen in one period, in one document.
 * `scope`: null = the whole kitchen, or the department ids a manager may see
 * (sales then only count their departments' dishes, and the kitchen-wide
 * money sections are left out unless `financial`).
 */
async function build(vendorId, period, { scope = null, financial = true, withComparison = true } = {}) {
  const vid = new ObjectId(String(vendorId));
  const range = { $gte: period.start, $lt: period.end };
  const inScope = (departmentId) => scope === null || (departmentId && scope.includes(String(departmentId)));

  const [orders, departments, invoices, movements, inventory, menu, staff, activityCount, refunds] = await Promise.all([
    Order.find({ vendor_id: vid, created_at: range })
      .select('customer_id order_number status fulfillment source payment_method payment_status subtotal_rwf delivery_fee_rwf total_rwf commission_rwf vendor_payout_rwf items tickets table created_at completed_at cancelled_at status_history kitchen_courier')
      .lean(),
    departmentService.listForVendor(vid),
    financial ? Invoice.find({ vendor_id: vid, $or: [{ created_at: range }, { 'payments.at': range }, { 'refunds.at': range }] }).lean() : [],
    StockMovement.find({ vendor_id: vid, created_at: range, ...(scope ? { department_id: { $in: scope.map((id) => new ObjectId(id)) } } : {}) }).lean(),
    InventoryItem.find({ vendor_id: vid, deleted_at: null, ...(scope ? { department_id: { $in: scope.map((id) => new ObjectId(id)) } } : {}) }).lean(),
    MenuItem.find({ vendor_id: vid, deleted_at: null }).select('name department_id is_available').lean(),
    financial ? KitchenStaff.find({ vendor_id: vid }).select('name').lean() : [],
    financial ? KitchenActivity.countDocuments({ vendor_id: vid, created_at: range }) : 0,
    financial ? Refund.find({ vendor_id: vid, created_at: range }).lean().catch(() => []) : [],
  ]);
  const departmentName = new Map(departments.map((d) => [String(d._id), d.name]));
  const nameOf = (id) => (id ? departmentName.get(String(id)) || 'Removed department' : 'Kitchen (no department)');

  // --- orders & sales
  const sales = { gross_rwf: 0, food_rwf: 0, delivery_fees_rwf: 0, commission_rwf: 0, kitchen_earnings_online_rwf: 0, in_person_rwf: 0, online_rwf: 0 };
  const byFulfillment = {};
  const bySource = {};
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, sales_rwf: 0 }));
  const seriesMap = new Map();
  const deptStats = new Map();
  const products = new Map();
  const tables = new Map();
  const prepTimes = [];
  const fulfilTimes = [];
  let placed = 0;
  let completed = 0;
  let cancelled = 0;
  let cancelledValue = 0;
  const seriesKey = (date) => {
    const l = local(date);
    if (period.type === 'yearly') return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}`;
    if (period.type === 'daily') return `${String(l.getUTCHours()).padStart(2, '0')}:00`;
    return l.toISOString().slice(0, 10);
  };

  for (const order of orders) {
    const lines = (order.items || []).filter((item) => inScope(item.department_id));
    if (scope !== null && !lines.length) continue;
    const value = lines.reduce((sum, item) => sum + item.subtotal_rwf, 0) + (scope === null ? order.delivery_fee_rwf || 0 : 0);
    placed += 1;
    if (order.status === 'cancelled') {
      cancelled += 1;
      cancelledValue += value;
      continue;
    }
    if (order.status === 'delivered') completed += 1;
    if (!isSale(order)) continue;
    const food = lines.reduce((sum, item) => sum + item.subtotal_rwf, 0);
    sales.gross_rwf += value;
    sales.food_rwf += food;
    if (scope === null) {
      sales.delivery_fees_rwf += order.delivery_fee_rwf || 0;
      sales.commission_rwf += order.commission_rwf || 0;
      if (order.payment_method === 'in_person') sales.in_person_rwf += value;
      else {
        sales.online_rwf += value;
        sales.kitchen_earnings_online_rwf += order.vendor_payout_rwf || Math.max(0, food - (order.commission_rwf || 0));
      }
    }
    const f = order.fulfillment || 'delivery';
    byFulfillment[f] = byFulfillment[f] || { orders: 0, sales_rwf: 0 };
    byFulfillment[f].orders += 1;
    byFulfillment[f].sales_rwf += value;
    const src = order.source || 'marketplace';
    bySource[src] = bySource[src] || { orders: 0, sales_rwf: 0 };
    bySource[src].orders += 1;
    bySource[src].sales_rwf += value;
    const hour = local(order.created_at).getUTCHours();
    byHour[hour].orders += 1;
    byHour[hour].sales_rwf += value;
    const key = seriesKey(order.created_at);
    const point = seriesMap.get(key) || { key, orders: 0, sales_rwf: 0 };
    point.orders += 1;
    point.sales_rwf += value;
    seriesMap.set(key, point);
    if (order.table?.label) {
      const t = tables.get(order.table.label) || { table: order.table.label, orders: 0, sales_rwf: 0 };
      t.orders += 1;
      t.sales_rwf += value;
      tables.set(order.table.label, t);
    }
    for (const item of lines) {
      const dk = item.department_id ? String(item.department_id) : 'main';
      const d = deptStats.get(dk) || { department_id: item.department_id ? String(item.department_id) : null, name: nameOf(item.department_id), sales_rwf: 0, items_sold: 0, orders: new Set(), tickets: 0, prep_minutes: [] };
      d.sales_rwf += item.subtotal_rwf;
      d.items_sold += item.quantity;
      d.orders.add(String(order._id));
      deptStats.set(dk, d);
      const pk = item.menu_item_id ? String(item.menu_item_id) : item.name;
      const p = products.get(pk) || { name: item.name, department: nameOf(item.department_id), quantity: 0, sales_rwf: 0 };
      p.quantity += item.quantity;
      p.sales_rwf += item.subtotal_rwf;
      products.set(pk, p);
    }
    for (const ticket of order.tickets || []) {
      if (!inScope(ticket.department_id) || ticket.status === 'cancelled') continue;
      const dk = ticket.department_id ? String(ticket.department_id) : 'main';
      const d = deptStats.get(dk);
      if (!d) continue;
      d.tickets += 1;
      const minutes = minutesBetween(order.created_at, ticket.ready_at);
      if (minutes !== null) {
        d.prep_minutes.push(minutes);
        prepTimes.push(minutes);
      }
    }
    const done = minutesBetween(order.created_at, order.completed_at);
    if (done !== null) fulfilTimes.push(done);
  }
  const salesOrders = Object.values(byFulfillment).reduce((s, f) => s + f.orders, 0);

  const departmentsReport = [...deptStats.values()]
    .map((d) => ({ department_id: d.department_id, name: d.name, sales_rwf: d.sales_rwf, items_sold: d.items_sold, orders: d.orders.size, tickets: d.tickets, avg_prep_minutes: avg(d.prep_minutes) }))
    .sort((a, b) => b.sales_rwf - a.sales_rwf);
  const productList = [...products.values()].sort((a, b) => b.quantity - a.quantity || b.sales_rwf - a.sales_rwf);
  const soldNames = new Set(productList.map((p) => p.name));
  const notSold = menu.filter((m) => inScope(m.department_id) && m.is_available && !soldNames.has(m.name)).map((m) => m.name).slice(0, 15);

  // --- payments
  let payments = null;
  if (financial) {
    const byMethod = {};
    let collected = 0;
    let refundedInPerson = 0;
    for (const invoice of invoices) {
      for (const payment of invoice.payments || []) {
        if (payment.at < period.start || payment.at >= period.end || payment.channel !== 'in_person') continue;
        byMethod[payment.method] = (byMethod[payment.method] || 0) + payment.amount_rwf;
        collected += payment.amount_rwf;
      }
      for (const refund of invoice.refunds || []) {
        if (refund.at >= period.start && refund.at < period.end) refundedInPerson += refund.amount_rwf;
      }
    }
    const created = invoices.filter((i) => i.created_at >= period.start && i.created_at < period.end);
    payments = {
      invoices_created: created.length,
      invoices_paid: created.filter((i) => i.status === 'paid').length,
      collected_in_person_rwf: collected,
      collected_by_method: Object.entries(byMethod).map(([method, amount_rwf]) => ({ method, amount_rwf })),
      paid_online_rwf: sales.online_rwf,
      outstanding_rwf: created.filter((i) => ['unpaid', 'partially_paid'].includes(i.status)).reduce((s, i) => s + (i.total_rwf - i.amount_paid_rwf), 0),
      unpaid_invoices: created.filter((i) => ['unpaid', 'partially_paid'].includes(i.status)).map((i) => ({ id: String(i._id), invoice_number: i.invoice_number, table: i.table_label || null, balance_due_rwf: i.total_rwf - i.amount_paid_rwf })).slice(0, 20),
      refunded_in_person_rwf: refundedInPerson,
      refunded_online_rwf: refunds.reduce((s, r) => s + (r.amount_rwf || 0), 0),
    };
  }

  // --- staff
  let staffReport = null;
  if (financial) {
    const perStaff = new Map();
    const bump = (actor, field, n = 1) => {
      if (!actor || actor.type !== 'staff' || !actor.id) return;
      const row = perStaff.get(actor.id) || { staff_id: actor.id, name: actor.name, tickets_done: 0, items_served: 0, payments_taken: 0, payments_rwf: 0 };
      row[field] += n;
      perStaff.set(actor.id, row);
    };
    for (const order of orders) {
      for (const ticket of order.tickets || []) {
        const readyStep = (ticket.history || []).find((h) => h.status === 'ready');
        if (readyStep) bump(readyStep.by, 'tickets_done');
      }
      for (const item of order.items || []) if (item.service_status === 'served') bump(item.served_by, 'items_served', item.quantity);
    }
    for (const invoice of invoices) {
      for (const payment of invoice.payments || []) {
        if (payment.at < period.start || payment.at >= period.end) continue;
        bump(payment.received_by, 'payments_taken');
        bump(payment.received_by, 'payments_rwf', payment.amount_rwf);
      }
    }
    const names = new Map(staff.map((s) => [String(s._id), s.name]));
    staffReport = [...perStaff.values()].map((row) => ({ ...row, name: names.get(row.staff_id) || row.name })).sort((a, b) => b.tickets_done + b.items_served - (a.tickets_done + a.items_served));
  }

  // --- inventory
  const usage = new Map();
  const movementTotals = {};
  for (const m of movements) {
    movementTotals[m.reason] = (movementTotals[m.reason] || 0) + 1;
    if (m.delta < 0) usage.set(String(m.item_id), (usage.get(String(m.item_id)) || 0) - m.delta);
  }
  const itemName = new Map(inventory.map((i) => [String(i._id), i]));
  const inventoryReport = {
    movements: movements.length,
    movements_by_reason: movementTotals,
    most_used: [...usage.entries()].map(([id, qty]) => ({ name: itemName.get(id)?.name || 'Removed item', unit: itemName.get(id)?.unit || '', used: Math.round(qty * 1000) / 1000 })).sort((a, b) => b.used - a.used).slice(0, 10),
    low_stock: inventory.filter((i) => i.low_stock_threshold > 0 && i.quantity <= i.low_stock_threshold).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, threshold: i.low_stock_threshold })),
    stock_value_rwf: inventory.reduce((s, i) => s + Math.max(0, i.quantity) * (i.cost_per_unit_rwf || 0), 0),
  };

  // Customers: app customers who ordered, new to the kitchen or returning, and the biggest spenders.
  const customerSpend = new Map();
  for (const order of orders) {
    if (!order.customer_id || order.status === 'cancelled' || !isSale(order)) continue;
    const key = String(order.customer_id);
    const row = customerSpend.get(key) || { customer_id: key, orders: 0, spent_rwf: 0 };
    row.orders += 1;
    row.spent_rwf += order.total_rwf;
    customerSpend.set(key, row);
  }
  let customersReport = null;
  if (customerSpend.size) {
    const ids = [...customerSpend.keys()].map((id) => new ObjectId(id));
    const before = new Set((await Order.distinct('customer_id', { vendor_id: vid, customer_id: { $in: ids }, created_at: { $lt: period.start } })).map(String));
    const names = new Map((await require('../../models').Customer.find({ _id: { $in: ids } }).select('name').lean()).map((c) => [String(c._id), c.name]));
    customersReport = {
      customers: customerSpend.size,
      new_customers: [...customerSpend.keys()].filter((id) => !before.has(id)).length,
      returning_customers: [...customerSpend.keys()].filter((id) => before.has(id)).length,
      table_guests: orders.filter((o) => o.fulfillment === 'dine_in' && !o.customer_id && o.status !== 'cancelled').length,
      top: [...customerSpend.values()].sort((a, b) => b.spent_rwf - a.spent_rwf).slice(0, 10).map((r) => ({ ...r, name: names.get(r.customer_id) || 'Customer' })),
    };
  } else {
    customersReport = { customers: 0, new_customers: 0, returning_customers: 0, table_guests: orders.filter((o) => o.fulfillment === 'dine_in' && o.status !== 'cancelled').length, top: [] };
  }

  const busiest = byHour.reduce((best, h) => (h.orders > best.orders ? h : best), byHour[0]);
  const report = {
    period: { type: period.type, label: period.label, start: period.start, end: period.end },
    scope: scope === null ? 'kitchen' : 'departments',
    generated_at: new Date(),
    summary: {
      orders_placed: placed,
      orders_completed: completed,
      orders_cancelled: cancelled,
      cancelled_value_rwf: cancelledValue,
      sales_rwf: sales.gross_rwf,
      average_order_rwf: salesOrders ? Math.round(sales.gross_rwf / salesOrders) : 0,
      items_sold: productList.reduce((s, p) => s + p.quantity, 0),
      avg_prep_minutes: avg(prepTimes),
      avg_completion_minutes: avg(fulfilTimes),
      busiest_hour: busiest.orders ? `${String(busiest.hour).padStart(2, '0')}:00–${String((busiest.hour + 1) % 24).padStart(2, '0')}:00` : null,
    },
    sales: financial ? sales : { food_rwf: sales.food_rwf },
    by_fulfillment: byFulfillment,
    by_source: bySource,
    series: [...seriesMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
    by_hour: byHour.filter((h) => h.orders),
    departments: departmentsReport,
    top_products: productList.slice(0, 10),
    not_sold: notSold,
    tables: [...tables.values()].sort((a, b) => b.sales_rwf - a.sales_rwf).slice(0, 15),
    payments,
    staff: staffReport,
    customers: scope === null ? customersReport : null,
    operations: scope === null ? await operationsSection(vid, period, orders) : null,
    inventory: inventoryReport,
    activity_entries: activityCount,
    definitions: {
      sales: 'Orders placed in this period that were not cancelled: app orders once paid, dine-in orders once placed. Includes delivery fees for the whole kitchen.',
      kitchen_earnings_online: 'What KitchenLink pays you for app orders: the food minus commission.',
      prep_minutes: 'From the order being placed to the department marking it ready.',
    },
  };

  if (withComparison && period.type !== 'custom') {
    const prev = await build(vendorId, previousPeriod(period), { scope, financial, withComparison: false });
    report.previous = { label: prev.period.label, sales_rwf: prev.summary.sales_rwf, orders_placed: prev.summary.orders_placed, cancelled: prev.summary.orders_cancelled };
    report.change = { sales_percent: pct(report.summary.sales_rwf, prev.summary.sales_rwf), orders_percent: pct(placed, prev.summary.orders_placed) };
  }
  report.highlights = highlights(report);
  return report;
}

/** The report in a few plain sentences, most important first. */
function highlights(r) {
  const out = [];
  const s = r.summary;
  const label = { daily: 'yesterday', weekly: 'last week', monthly: 'last month', yearly: 'last year' }[r.period.type] || 'the previous period';
  if (!s.orders_placed) {
    out.push('No orders in this period.');
    return out;
  }
  const count = s.orders_placed - s.orders_cancelled;
  let line = s.sales_rwf == null
    ? `${count} order${count === 1 ? '' : 's'} went through`
    : `You sold ${rwf(s.sales_rwf)} across ${count} order${count === 1 ? '' : 's'}`;
  if (s.sales_rwf != null && r.change?.sales_percent !== null && r.change?.sales_percent !== undefined) {
    const c = r.change.sales_percent;
    line += c === 0 ? `, the same as ${label}` : `, ${c > 0 ? 'up' : 'down'} ${Math.abs(c)}% on ${label}`;
  }
  out.push(`${line}.`);
  if ((r.departments || []).length > 1) out.push(`${r.departments[0].name} brought in the most: ${rwf(r.departments[0].sales_rwf)} (${r.departments[0].items_sold} items).`);
  if (r.top_products?.[0]) out.push(`Best seller: ${r.top_products[0].name} (${r.top_products[0].quantity} sold).`);
  if (s.orders_cancelled) out.push(`${s.orders_cancelled} order${s.orders_cancelled === 1 ? ' was' : 's were'} cancelled${s.cancelled_value_rwf != null ? ` (${rwf(s.cancelled_value_rwf)})` : ''}.`);
  if (s.busiest_hour) out.push(`Busiest time: ${s.busiest_hour}.`);
  if (s.avg_prep_minutes !== null) out.push(`Food was ready on average ${s.avg_prep_minutes} minutes after ordering.`);
  if (r.payments?.outstanding_rwf) out.push(`${rwf(r.payments.outstanding_rwf)} is still unpaid on ${r.payments.unpaid_invoices.length} bill${r.payments.unpaid_invoices.length === 1 ? '' : 's'}.`);
  const ops = r.operations;
  if (ops?.floor?.visits) out.push(`${ops.floor.visits} table visit${ops.floor.visits === 1 ? '' : 's'} (${ops.floor.guests} guests)${ops.floor.avg_visit_minutes !== null ? `, about ${Math.round(ops.floor.avg_visit_minutes)} minutes each` : ''}.`);
  if (ops?.reservations?.total) out.push(`${ops.reservations.total} booking${ops.reservations.total === 1 ? '' : 's'}${ops.reservations.attendance_percent !== null ? `; ${ops.reservations.attendance_percent}% of guests came` : ''}${ops.reservations.by_status.no_show ? ` (${ops.reservations.by_status.no_show} no-show)` : ''}.`);
  if (ops?.service?.avg_wait_to_serve_minutes) out.push(`Ready food waited ${ops.service.avg_wait_to_serve_minutes} minutes on average before reaching the table.`);
  if (ops?.deliveries?.failed_attempts) out.push(`${ops.deliveries.failed_attempts} delivery attempt${ops.deliveries.failed_attempts === 1 ? '' : 's'} by your couriers failed.`);
  if (r.inventory?.low_stock?.length) out.push(`${r.inventory.low_stock.length} stock item${r.inventory.low_stock.length === 1 ? ' is' : 's are'} low: ${r.inventory.low_stock.slice(0, 3).map((i) => i.name).join(', ')}.`);
  return out;
}

// ------------------------------------------------------------ CSV export

const csvCell = (v) => {
  const text = v === null || v === undefined ? '' : String(v);
  // Cells starting with = + - @ are prefixed so a spreadsheet never runs them as formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvRows = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\n');

function toCsv(input) {
  let report = input;
  const parts = [];
  const section = (title, header, rows) => {
    parts.push(csvRows([[title], header, ...rows]));
  };
  section(`KitchenLink report: ${report.period.label}`, ['Measure', 'Value'], [
    ...Object.entries(report.summary).map(([k, v]) => [k.replace(/_/g, ' '), v]),
    ...Object.entries(report.sales || {}).map(([k, v]) => [k.replace(/_/g, ' '), v]),
  ]);
  section('Highlights', ['Note'], report.highlights.map((h) => [h]));
  report = { ...report, departments: report.departments || [], top_products: report.top_products || [], series: report.series || [], inventory: report.inventory || { most_used: [], low_stock: [] } };
  section('Departments', ['Department', 'Sales (RWF)', 'Items sold', 'Orders', 'Tickets', 'Avg prep (min)'], report.departments.map((d) => [d.name, d.sales_rwf, d.items_sold, d.orders, d.tickets, d.avg_prep_minutes]));
  section('Products', ['Product', 'Department', 'Quantity', 'Sales (RWF)'], report.top_products.map((p) => [p.name, p.department, p.quantity, p.sales_rwf]));
  section('Over time', ['When', 'Orders', 'Sales (RWF)'], report.series.map((p) => [p.key, p.orders, p.sales_rwf]));
  if (report.payments) {
    section('Payments', ['Measure', 'Value'], [
      ['invoices created', report.payments.invoices_created],
      ['collected in person', report.payments.collected_in_person_rwf],
      ['paid online', report.payments.paid_online_rwf],
      ['outstanding', report.payments.outstanding_rwf],
      ['refunded in person', report.payments.refunded_in_person_rwf],
      ...report.payments.collected_by_method.map((m) => [`collected: ${m.method}`, m.amount_rwf]),
    ]);
  }
  if (report.staff) section('Staff', ['Employee', 'Tickets done', 'Items served', 'Payments taken', 'Payments (RWF)'], report.staff.map((s) => [s.name, s.tickets_done, s.items_served, s.payments_taken, s.payments_rwf]));
  if (report.operations?.floor) section('Tables', ['Table', 'Visits', 'Guests', 'Hours used', 'Use (%)'], report.operations.floor.tables.map((t) => [t.label, t.visits, t.guests, t.hours_used, t.utilization_percent]));
  if (report.operations?.reservations) section('Reservations', ['Status', 'Bookings'], Object.entries(report.operations.reservations.by_status).map(([k, v]) => [k.replace('_', ' '), v]));
  section('Stock used', ['Item', 'Used', 'Unit'], report.inventory.most_used.map((i) => [i.name, i.used, i.unit]));
  section('Low stock', ['Item', 'Left', 'Unit', 'Alert level'], report.inventory.low_stock.map((i) => [i.name, i.quantity, i.unit, i.threshold]));
  return `${parts.join('\n\n')}\n`;
}

// ------------------------------------------------------------ service

class ReportService {
  /**
   * What this person may see. Kitchen-wide money needs a sales / financial
   * permission; otherwise only the departments their role covers. Each
   * section of the report then needs its own permission (#keepAllowed).
   */
  #scopeFor(kitchen, query) {
    const wide = ['reports.sales', 'reports.financial', 'finance.revenue', 'overview.financial_summary'].some((p) => kitchen.can(p));
    const departmentPermissions = ['reports.departments', 'finance.department_revenue', 'overview.department_performance', 'departments.performance'];
    let scope = null;
    if (!wide) {
      const ids = new Set();
      let all = false;
      for (const permission of departmentPermissions) {
        const s = kitchen.scope(permission);
        if (s === null) all = true;
        else s.forEach((id) => ids.add(id));
      }
      scope = all ? null : [...ids];
    }
    if (query.department_id && query.department_id !== 'all') {
      if (!mongoose.isValidObjectId(query.department_id)) throw ApiError.badRequest('department_id must be a valid id.', { department_id: 'invalid' });
      const id = String(query.department_id);
      if (!wide && !departmentPermissions.some((p) => kitchen.can(p, id))) kitchen.assert('reports.departments', id);
      scope = [id];
    }
    // Kitchen-wide reports are built in full; #keepAllowed then removes what the role doesn't show.
    return { scope, financial: scope === null };
  }

  /** Removes the sections of a report this person's role doesn't show. */
  #keepAllowed(kitchen, report) {
    if (kitchen.isAdmin) return report;
    const any = (...permissions) => permissions.some((p) => kitchen.can(p));
    const out = { ...report };
    const money = any('reports.sales', 'reports.financial', 'finance.revenue', 'overview.financial_summary', 'overview.sales');
    if (!money) {
      out.sales = null;
      out.summary = { ...out.summary, sales_rwf: null, average_order_rwf: null, cancelled_value_rwf: null };
      out.series = out.series.map(({ sales_rwf: _s, ...rest }) => rest);
      out.by_fulfillment = Object.fromEntries(Object.entries(out.by_fulfillment || {}).map(([k, v]) => [k, { orders: v.orders }]));
      out.tables = (out.tables || []).map(({ sales_rwf: _s, ...rest }) => rest);
      out.previous = out.previous ? { ...out.previous, sales_rwf: null } : out.previous;
      out.change = out.change ? { ...out.change, sales_percent: null } : out.change;
    }
    if (!any('reports.orders', 'overview.orders', 'overview.statistics', 'reports.sales')) {
      out.by_hour = [];
      out.by_source = {};
    }
    if (!any('reports.products', 'reports.sales')) {
      out.top_products = [];
      out.not_sold = [];
    }
    if (!any('reports.departments', 'finance.department_revenue', 'overview.department_performance', 'departments.performance', 'reports.sales')) out.departments = [];
    if (!any('reports.employees', 'staff.view_performance')) out.staff = null;
    if (!any('reports.customers')) out.customers = null;
    if (out.operations) {
      const ops = { ...out.operations };
      if (!any('reports.orders', 'tables.sessions_view', 'reports.sales', 'overview.statistics')) ops.floor = null;
      if (!any('reports.orders', 'reservations.view', 'reports.sales')) ops.reservations = null;
      else if (!money && ops.reservations) ops.reservations = { ...ops.reservations, deposits: null };
      if (!any('reports.orders', 'service.view_ready', 'reports.sales')) ops.service = null;
      if (!any('reports.orders', 'delivery.history', 'delivery.track', 'reports.sales')) ops.deliveries = null;
      out.operations = ops;
    }
    if (!any('reports.inventory', 'inventory.reports')) out.inventory = { movements: 0, movements_by_reason: {}, most_used: [], low_stock: [], stock_value_rwf: null, hidden: true };
    if (!any('reports.payments', 'reports.financial', 'finance.payment_summaries', 'invoices.cashier_reports')) out.payments = null;
    out.highlights = highlights(out);
    return out;
  }

  /**
   * GET /vendor/reports — the report for a period. A closed period that was
   * generated automatically comes from storage; the current one is live.
   */
  async get(kitchen, query = {}) {
    const period = parsePeriod(query);
    const { scope, financial } = this.#scopeFor(kitchen, query);
    const closed = period.end <= new Date();
    if (closed && scope === null && financial && period.type !== 'custom') {
      const stored = await KitchenReport.findOne({ vendor_id: kitchen.vendorId, period: period.type, start: period.start }).lean();
      if (stored) return { ...this.#keepAllowed(kitchen, stored.data), stored: true, generated_at: stored.generated_at };
    }
    const report = await build(kitchen.vendorId, period, { scope, financial });
    if (closed && scope === null && financial && period.type !== 'custom') await this.#store(kitchen.vendorId, period, report, 'manual');
    return { ...this.#keepAllowed(kitchen, report), stored: false, live: !closed };
  }

  /** The kitchen's saved reports, newest first. */
  async history(kitchen, query = {}) {
    const period = PERIODS.includes(query.period) ? query.period : 'monthly';
    const rows = await KitchenReport.find({ vendor_id: kitchen.vendorId, period }).sort({ start: -1 }).limit(60).lean();
    return {
      period,
      reports: rows.map((r) => ({
        id: String(r._id),
        period: r.period,
        label: r.label,
        start: r.start,
        end: r.end,
        sales_rwf: r.data?.summary?.sales_rwf ?? 0,
        orders_placed: r.data?.summary?.orders_placed ?? 0,
        highlights: (r.data?.highlights || []).slice(0, 2),
        generated_at: r.generated_at,
      })),
    };
  }

  async exportCsv(kitchen, query = {}) {
    const report = await this.get(kitchen, query);
    const safeLabel = report.period.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { filename: `kitchenlink-${report.period.type}-${safeLabel}.csv`, body: toCsv(report) };
  }

  async #store(vendorId, period, data, by) {
    await KitchenReport.updateOne(
      { vendor_id: vendorId, period: period.type, start: period.start },
      { $set: { end: period.end, label: period.label, data, generated_at: new Date(), generated_by: by } },
      { upsert: true }
    );
  }

  /**
   * The schedule: for every kitchen that had orders, saves the report of the
   * day, week, month and year that just ended (once each), and tells the
   * kitchen when a weekly, monthly or yearly report is ready.
   */
  async generateDue(now = new Date()) {
    for (const type of PERIODS) {
      const period = previousPeriod(periodContaining(type, now));
      const vendorIds = await Order.distinct('vendor_id', { created_at: { $gte: period.start, $lt: period.end } });
      for (const vendorId of vendorIds) {
        const exists = await KitchenReport.exists({ vendor_id: vendorId, period: type, start: period.start });
        if (exists) continue;
        try {
          const report = await build(vendorId, period, {});
          await this.#store(vendorId, period, report, 'schedule');
          if (type !== 'daily') {
            notificationService
              .notifyVendor(vendorId, {
                type: 'general',
                title: `${PERIOD_LABEL[type]} report: ${period.label}`,
                body: report.highlights[0] || 'Your report is ready.',
                link: `/vendor-dashboard/reports?period=${type}&date=${local(period.start).toISOString().slice(0, 10)}`,
              })
              .catch(() => null);
          }
        } catch (error) {
          console.error(`[reports] could not generate the ${type} report for ${vendorId}:`, error.message);
        }
      }
    }
  }

  start() {
    if (this.timer || config.env === 'test') return;
    const run = () => this.generateDue().catch((error) => console.error('[reports] schedule failed:', error.message));
    // Shortly after boot, then every 30 minutes (a period's report is saved in the first run after it ends).
    this.bootTimer = setTimeout(run, 60 * 1000);
    this.timer = setInterval(run, 30 * 60 * 1000);
    this.timer.unref?.();
    this.bootTimer.unref?.();
  }

  /** A short live summary for the dashboard: today so far. */
  async today(kitchen) {
    const { scope, financial } = this.#scopeFor(kitchen, {});
    const report = this.#keepAllowed(kitchen, await build(kitchen.vendorId, periodContaining('daily'), { scope, financial }));
    return { period: report.period, summary: report.summary, highlights: report.highlights, departments: report.departments, change: report.change || null };
  }
}

module.exports = new ReportService();
Object.assign(module.exports, { build, periodContaining, previousPeriod, parsePeriod, highlights, toCsv });

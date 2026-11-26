const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId } = require('../../utils/vendorValidators');
const { MenuItem, Order, Vendor } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const MAIN = { name: 'Kitchen', prefix: 'K' };
const OPEN_TICKET = ['pending', 'accepted', 'preparing'];
const STAGE_RANK = { pending: 0, accepted: 1, preparing: 2, ready: 3 };
// The kitchen-facing order status a set of tickets amounts to.
const VENDOR_STEPS = ['new', 'accepted', 'preparing', 'ready'];
const TICKET_TO_VENDOR = { pending: 'new', accepted: 'accepted', preparing: 'preparing', ready: 'ready' };
// Any one of these allows the move to that stage.
const STAGE_PERMISSION = {
  accepted: ['kitchen.accept_tasks', 'kitchen.update_progress'],
  preparing: ['kitchen.start_preparation', 'kitchen.update_progress'],
  ready: ['kitchen.mark_ready'],
};
const ACTIVE_ORDER_STATUSES = ['placed', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'out_for_delivery'];

const shortRef = (orderNumber = '') => String(orderNumber).split('-').pop() || String(orderNumber);

/**
 * Splits an order's lines by the department that prepares each dish and
 * builds one ticket per department. Dishes with no (active) department go to
 * the kitchen's own ticket, so kitchens without departments get one ticket.
 * Returns the lines (with their department and ticket) and the tickets.
 */
async function buildTickets(vendorId, items, orderNumber) {
  const ids = items.map((item) => item.menu_item_id).filter(Boolean);
  const [dishes, departments] = await Promise.all([
    ids.length ? MenuItem.find({ _id: { $in: ids } }).select('department_id').lean() : [],
    departmentService.activeMap(vendorId),
  ]);
  const dishDepartment = new Map(dishes.map((dish) => [String(dish._id), dish.department_id ? String(dish.department_id) : null]));
  const tickets = new Map();
  const now = new Date();
  const lines = items.map((item) => {
    let departmentId = item.menu_item_id ? dishDepartment.get(String(item.menu_item_id)) : null;
    if (departmentId && !departments.has(departmentId)) departmentId = null;
    const key = departmentId || 'main';
    if (!tickets.has(key)) {
      const department = departmentId ? departments.get(departmentId) : null;
      tickets.set(key, {
        _id: new ObjectId(),
        department_id: department ? department._id : null,
        department_name: department ? department.name : MAIN.name,
        code: `${department ? department.code_prefix || 'X' : MAIN.prefix}${shortRef(orderNumber)}`,
        status: 'pending',
        history: [{ status: 'pending', at: now, by: { type: 'system', name: 'System' }, note: 'Received' }],
      });
    }
    const ticket = tickets.get(key);
    return {
      ...item,
      department_id: ticket.department_id,
      department_name: ticket.department_name,
      ticket_id: ticket._id,
      service_status: 'pending',
    };
  });
  return { items: lines, tickets: [...tickets.values()] };
}

/** Older orders (placed before departments existed) get their ticket the first time it's needed. */
async function ensureTickets(order) {
  if (order.tickets && order.tickets.length) return order;
  if (['delivered', 'cancelled'].includes(order.status)) return order;
  const built = await buildTickets(order.vendor_id, order.items.map((item) => (item.toObject ? item.toObject() : item)), order.order_number);
  const stage = { placed: 'pending', confirmed: 'accepted', preparing: 'preparing' }[order.status] || 'ready';
  for (const ticket of built.tickets) {
    ticket.status = stage;
    if (stage === 'ready') ticket.ready_at = new Date();
  }
  const items = built.items.map((item) => ({ ...item, service_status: stage === 'ready' ? 'waiting_collection' : 'pending' }));
  return Order.findOneAndUpdate(
    { _id: order._id, $or: [{ tickets: { $size: 0 } }, { tickets: { $exists: false } }] },
    { $set: { tickets: built.tickets, items } },
    { returnDocument: 'after' }
  ).lean().then((saved) => saved || Order.findById(order._id).lean());
}

/** Order status the tickets amount to (kitchen vocabulary). */
function statusFromTickets(tickets = []) {
  const live = tickets.filter((t) => t.status !== 'cancelled');
  if (!live.length) return null;
  if (live.every((t) => t.status === 'ready')) return 'ready';
  if (live.some((t) => ['preparing', 'ready'].includes(t.status))) return 'preparing';
  if (live.some((t) => t.status === 'accepted')) return 'accepted';
  return 'new';
}

function serializeTicket(ticket, order, department) {
  const stages = departmentService.workflowStages(department);
  const labels = { ...access.PREP_STAGE_LABELS, ...(department?.workflow?.labels || {}) };
  const currentIndex = stages.findIndex((s) => s.id === ticket.status);
  const next = ticket.status === 'cancelled' || ticket.status === 'ready' ? [] : stages.slice(currentIndex + 1).map((s) => s.id);
  const items = (order.items || []).filter((item) => String(item.ticket_id) === String(ticket._id));
  return {
    id: String(ticket._id),
    code: ticket.code,
    department_id: ticket.department_id ? String(ticket.department_id) : null,
    department_name: ticket.department_name,
    status: ticket.status,
    status_label: labels[ticket.status] || ticket.status,
    allowed_next_statuses: next.map((id) => ({ id, label: labels[id] || id })),
    station_id: ticket.station_id || null,
    paused: Boolean(ticket.paused),
    pause_reason: ticket.pause_reason || '',
    assigned_staff_id: ticket.assigned_staff_id ? String(ticket.assigned_staff_id) : null,
    assigned_staff_name: ticket.assigned_staff_name || '',
    accepted_at: ticket.accepted_at ?? null,
    started_at: ticket.started_at ?? null,
    ready_at: ticket.ready_at ?? null,
    history: (ticket.history || []).map((h) => ({ status: h.status, at: h.at, by: h.by?.name || '', note: h.note || '' })),
    items: items.map((item) => ({
      id: String(item._id),
      name: item.name,
      quantity: item.quantity,
      note: item.note || '',
      options: (item.options || []).map((o) => `${o.group_name}: ${o.name}`),
      service_status: item.service_status || 'pending',
    })),
    order: {
      id: String(order._id),
      order_number: order.order_number,
      fulfillment: order.fulfillment || 'delivery',
      fulfillment_label: config.orders.fulfillmentLabels[order.fulfillment || 'delivery'],
      table_label: order.table?.label || null,
      guest_name: order.guest?.name || null,
      order_type: order.order_type || 'immediate',
      scheduled_for: order.scheduled_for ?? null,
      placed_at: order.created_at,
      payment_status: order.payment_status,
      status: order.status,
      priority: order.priority || 'normal',
    },
  };
}

/** Serializes every ticket of an order for the customer / server views. */
function ticketProgress(order, departments = new Map()) {
  return (order.tickets || []).map((ticket) => {
    const department = ticket.department_id ? departments.get(String(ticket.department_id)) : null;
    const labels = { ...access.PREP_STAGE_LABELS, ...(department?.workflow?.labels || {}) };
    const items = (order.items || []).filter((item) => String(item.ticket_id) === String(ticket._id));
    return {
      id: String(ticket._id),
      code: ticket.code,
      department_id: ticket.department_id ? String(ticket.department_id) : null,
      department_name: ticket.department_name,
      status: ticket.status,
      status_label: labels[ticket.status] || ticket.status,
      ready_at: ticket.ready_at ?? null,
      items: items.map((item) => ({
        id: String(item._id),
        name: item.name,
        quantity: item.quantity,
        service_status: item.service_status || 'pending',
        service_status_label: access.SERVICE_STATUS_LABELS[item.service_status || 'pending'],
      })),
    };
  });
}

/** Whether a dine-in order may be prepared / collected yet, by the kitchen's payment rule. */
function paymentBlocks(order, vendor, step) {
  if (order.payment_status === 'paid') return false;
  if (order.payment_method !== 'in_person') return true; // online orders: paid first, always
  // The rule in force when the order was placed (kept on the order).
  const gate = order.payment_gate || access.paymentGate(vendor?.operations?.payment_timing);
  if (step === 'collection') return gate === 'preparation' || gate === 'collection';
  return gate === step;
}

class TicketService {
  /** The preparation queue: open tickets of the departments this person may see. */
  async queue(kitchen, query = {}) {
    const scope = kitchen.scope('kitchen.view_queue');
    if (scope !== null && scope.length === 0) kitchen.assert('kitchen.view_queue');
    const history = query.status === 'history';
    if (history) kitchen.assert('kitchen.view_history');
    const wanted = query.department_id || null; // a department id, 'main' (no department) or all
    if (wanted && wanted !== 'main') parseObjectId(wanted, 'department_id');
    const statuses = history ? ['ready', 'cancelled'] : OPEN_TICKET.concat(['ready']);

    // Which tickets this person sees: the department asked for, within their scope.
    const visible = (departmentId) => {
      const id = departmentId ? String(departmentId) : null;
      if (wanted === 'main' && id !== null) return false;
      if (wanted && wanted !== 'main' && id !== wanted) return false;
      if (scope !== null && (id === null || !scope.includes(id))) return false;
      return true;
    };
    const elem = { status: { $in: statuses } };
    if (wanted === 'main') elem.department_id = null;
    else if (wanted) elem.department_id = new ObjectId(wanted);
    else if (scope !== null) elem.department_id = { $in: scope.map((id) => new ObjectId(id)) };

    const filter = { vendor_id: kitchen.vendorId, tickets: { $elemMatch: elem } };
    if (!history) filter.status = { $in: ACTIVE_ORDER_STATUSES };
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 100 });
    const [orders, total, vendor, departmentList] = await Promise.all([
      Order.find(filter).sort({ created_at: history ? -1 : 1 }).skip(offset).limit(limit).lean(),
      Order.countDocuments(filter),
      Vendor.findById(kitchen.vendorId).select('operations').lean(),
      departmentService.listForVendor(kitchen.vendorId),
    ]);
    const departments = new Map(departmentList.map((d) => [String(d._id), d]));
    const tickets = [];
    for (const order of orders) {
      for (const ticket of order.tickets) {
        if (!statuses.includes(ticket.status) || !visible(ticket.department_id)) continue;
        const serialized = serializeTicket(ticket, order, ticket.department_id ? departments.get(String(ticket.department_id)) : null);
        // A ready ticket leaves the live board once nothing of it waits at the counter.
        if (!history && ticket.status === 'ready' && !serialized.items.some((i) => i.service_status === 'waiting_collection')) continue;
        serialized.payment_hold = paymentBlocks(order, vendor, 'preparation');
        tickets.push(serialized);
      }
    }
    // Urgent first, then high, then oldest first.
    const rank = { urgent: 0, high: 1, normal: 2 };
    if (!history) tickets.sort((a, b) => (rank[a.order.priority] ?? 2) - (rank[b.order.priority] ?? 2));
    return { tickets, meta: { page, limit, total } };
  }

  async #loadOrder(vendorId, orderId) {
    const id = parseObjectId(orderId, 'order_id');
    let order = await Order.findOne({ _id: id, vendor_id: vendorId }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    order = await ensureTickets(order);
    return order;
  }

  /**
   * Moves one department's ticket to a later stage of its workflow. When
   * every ticket is ready the order becomes ready (and a delivery order is
   * dispatched, a pickup customer gets their code), through the same steps
   * as an owner marking the whole order ready.
   */
  async advance(vendor, kitchen, orderId, ticketId, body = {}) {
    const order = await this.#loadOrder(vendor._id, orderId);
    const tid = parseObjectId(ticketId, 'ticket_id');
    const ticket = order.tickets.find((t) => String(t._id) === String(tid));
    if (!ticket) throw ApiError.notFound('Ticket not found.', 'TICKET_NOT_FOUND');
    const next = String(body.status || '');
    if (!STAGE_PERMISSION[next]) {
      throw ApiError.badRequest('status must be accepted, preparing or ready.', { status: 'expected accepted, preparing or ready' });
    }
    const ticketDepartment = ticket.department_id ? String(ticket.department_id) : null;
    if (!STAGE_PERMISSION[next].some((permission) => kitchen.can(permission, ticketDepartment))) kitchen.assert(STAGE_PERMISSION[next][0], ticketDepartment);
    if (['cancelled', 'delivered'].includes(order.status)) {
      throw ApiError.conflict(`This order is already ${order.status === 'cancelled' ? 'cancelled' : 'completed'}.`, 'ORDER_CLOSED');
    }
    if (ticket.paused) {
      throw ApiError.conflict('This ticket is paused. Resume it first.', 'TICKET_PAUSED');
    }
    if (paymentBlocks(order, vendor, 'preparation')) {
      throw ApiError.conflict(
        order.payment_method === 'in_person'
          ? "This table's bill must be paid before preparation starts (your payment rule). Ask the cashier."
          : "The customer hasn't paid for this order yet. Wait for payment before preparing it.",
        'PAYMENT_PENDING'
      );
    }
    const department = ticket.department_id ? await mongoose.model('Department').findById(ticket.department_id).lean() : null;
    const stages = departmentService.workflowStages(department).map((s) => s.id);
    if (!stages.includes(next) || STAGE_RANK[next] <= STAGE_RANK[ticket.status] || ticket.status === 'cancelled') {
      throw ApiError.conflict(`This ticket can't move from "${ticket.status}" to "${next}".`, 'INVALID_TICKET_TRANSITION');
    }

    const now = new Date();
    const by = kitchen.actor;
    const set = { 'tickets.$[t].status': next };
    if (next === 'accepted') set['tickets.$[t].accepted_at'] = now;
    if (next === 'preparing') {
      set['tickets.$[t].started_at'] = now;
      if (!ticket.accepted_at) set['tickets.$[t].accepted_at'] = now;
    }
    if (next === 'ready') {
      set['tickets.$[t].ready_at'] = now;
      set['items.$[it].service_status'] = 'waiting_collection';
    }
    if (!ticket.assigned_staff_id && by.type === 'staff') {
      set['tickets.$[t].assigned_staff_id'] = new ObjectId(by.id);
      set['tickets.$[t].assigned_staff_name'] = by.name;
    }
    const arrayFilters = [{ 't._id': tid }];
    if (next === 'ready') arrayFilters.push({ 'it.ticket_id': new ObjectId(String(tid)), 'it.service_status': 'pending' });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, tickets: { $elemMatch: { _id: tid, status: ticket.status } } },
      { $set: set, $push: { 'tickets.$[t].history': { status: next, at: now, by, note } } },
      { arrayFilters, returnDocument: 'after' }
    ).lean();
    if (!updated) throw ApiError.conflict('Someone else just updated this ticket. Refresh and try again.', 'TICKET_CHANGED');

    activity.record(kitchen, {
      action: `ticket.${next}`,
      target_type: 'order',
      target_id: order._id,
      summary: `${ticket.code} (${ticket.department_name}) → ${next} for ${order.order_number}`,
      department_id: ticket.department_id,
    });
    if (next === 'ready') {
      require('./alertService').emit(vendor._id, 'order_alerts', {
        title: `${ticket.department_name} ready: ${updated.table?.label || updated.order_number}`,
        body: `${ticket.code} is waiting at the counter`,
        link: '/vendor-dashboard/service',
        permission: 'service.view_ready',
      });
      require('./inventoryService').deductForTicket(vendor, updated, ticket).catch((error) =>
        console.error('[inventory] could not deduct stock for', ticket.code, error.message)
      );
    }

    const parent = await this.syncParent(vendor, updated);
    return {
      ticket: serializeTicket(parent.order.tickets.find((t) => String(t._id) === String(tid)), parent.order, department),
      order_status: parent.order.status,
      order_note: parent.note,
    };
  }

  async #ticketOf(vendor, orderId, ticketId) {
    const order = await this.#loadOrder(vendor._id, orderId);
    const tid = parseObjectId(ticketId, 'ticket_id');
    const ticket = order.tickets.find((t) => String(t._id) === String(tid));
    if (!ticket) throw ApiError.notFound('Ticket not found.', 'TICKET_NOT_FOUND');
    if (['cancelled', 'delivered'].includes(order.status)) throw ApiError.conflict('This order is already closed.', 'ORDER_CLOSED');
    return { order, ticket, department: ticket.department_id ? String(ticket.department_id) : null };
  }

  /** "Pause preparation": the ticket waits (an ingredient is missing …) and can't move until resumed. */
  async pause(vendor, kitchen, orderId, ticketId, body = {}) {
    const { order, ticket, department } = await this.#ticketOf(vendor, orderId, ticketId);
    kitchen.assert('kitchen.pause', department);
    const paused = body.paused !== false;
    if (ticket.status === 'ready' || ticket.status === 'cancelled') throw ApiError.conflict('This ticket is already finished.', 'TICKET_FINISHED');
    const reason = paused ? String(body.reason || '').trim().slice(0, 140) : '';
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { 'tickets.$[t].paused': paused, 'tickets.$[t].paused_at': paused ? new Date() : null, 'tickets.$[t].pause_reason': reason },
        $push: { 'tickets.$[t].history': { status: paused ? 'paused' : 'resumed', at: new Date(), by: kitchen.actor, note: reason } },
      },
      { arrayFilters: [{ 't._id': ticket._id }] }
    );
    activity.record(kitchen, { action: paused ? 'ticket.paused' : 'ticket.resumed', target_type: 'order', target_id: order._id, summary: `${ticket.code} ${paused ? 'paused' : 'resumed'}${reason ? `: ${reason}` : ''}`, department_id: ticket.department_id });
    return { ticket: serializeTicket((await Order.findById(order._id).lean()).tickets.find((t) => String(t._id) === String(ticket._id)), await Order.findById(order._id).lean(), null) };
  }

  /**
   * "Cancel preparation tasks": a department can't make its part. Bills paid
   * in person lose those items; an app order was paid online, so the whole
   * order has to be cancelled (and refunded) instead.
   */
  async cancelTicket(vendor, kitchen, orderId, ticketId, body = {}) {
    const { order, ticket, department } = await this.#ticketOf(vendor, orderId, ticketId);
    kitchen.assert('kitchen.cancel_tasks', department);
    if (ticket.status === 'cancelled') return { ticket: serializeTicket(ticket, order, null), order_status: order.status };
    if (order.payment_method !== 'in_person' || order.payment_status === 'paid') {
      throw ApiError.conflict('This order is already paid, so part of it can\'t be dropped. Cancel the whole order to refund it.', 'ORDER_PAID');
    }
    const live = order.tickets.filter((t) => t.status !== 'cancelled');
    if (live.length <= 1) throw ApiError.conflict('This is the only ticket left: cancel the order instead.', 'LAST_TICKET');
    const reason = String(body.reason || '').trim().slice(0, 140) || 'Cancelled by the department';
    const now = new Date();
    const items = order.items.map((i) => (String(i.ticket_id) === String(ticket._id) ? { ...i, service_status: 'cancelled' } : i));
    const subtotal = items.filter((i) => i.service_status !== 'cancelled').reduce((sum, i) => sum + i.subtotal_rwf, 0);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { items, subtotal_rwf: subtotal, total_rwf: subtotal + (order.delivery_fee_rwf || 0), 'tickets.$[t].status': 'cancelled', 'tickets.$[t].cancelled_at': now, 'tickets.$[t].cancel_reason': reason },
        $push: { 'tickets.$[t].history': { status: 'cancelled', at: now, by: kitchen.actor, note: reason }, status_history: { status: order.status, at: now, note: `${ticket.department_name} part cancelled: ${reason}` } },
      },
      { arrayFilters: [{ 't._id': ticket._id }] }
    );
    await require('./invoiceService').syncOrderLines(order._id);
    activity.record(kitchen, { action: 'ticket.cancelled', target_type: 'order', target_id: order._id, summary: `${ticket.code} cancelled: ${reason}`, department_id: ticket.department_id });
    const parent = await this.syncParent(vendor, await Order.findById(order._id).lean());
    return { order_status: parent.order.status };
  }

  /** "Assign tasks to employees": who in the department makes this ticket. */
  async assignTicket(vendor, kitchen, orderId, ticketId, body = {}) {
    const { order, ticket, department } = await this.#ticketOf(vendor, orderId, ticketId);
    kitchen.assert('kitchen.assign_tasks', department);
    let staff = null;
    if (body.staff_id) {
      staff = await mongoose.model('KitchenStaff').findOne({ _id: parseObjectId(body.staff_id, 'staff_id'), vendor_id: vendor._id, deleted_at: null, is_active: true }).lean();
      if (!staff) throw ApiError.badRequest('That employee is not an active member of this kitchen.', { staff_id: 'unknown employee' });
    }
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'tickets.$[t].assigned_staff_id': staff ? staff._id : null, 'tickets.$[t].assigned_staff_name': staff ? staff.name : '' } },
      { arrayFilters: [{ 't._id': ticket._id }] }
    );
    if (staff) require('./alertService').toStaff(vendor._id, staff._id, { title: `${ticket.code} is yours`, body: `${ticket.department_name} · ${order.table?.label || order.order_number}`, link: '/vendor-dashboard/kitchen' });
    activity.record(kitchen, { action: 'ticket.assigned', target_type: 'order', target_id: order._id, summary: staff ? `${ticket.code} given to ${staff.name}` : `${ticket.code} unassigned`, department_id: ticket.department_id });
    return { ok: true };
  }

  /**
   * Brings the order's own status up to what its tickets amount to, one
   * step at a time through vendorOrderService (so the usual notifications,
   * pickup codes and dispatch happen). Never moves an order backwards.
   */
  async syncParent(vendor, order) {
    const vendorOrderService = require('../vendorOrderService');
    let note = null;
    let latest = order;
    // Re-read on every step: another department may have moved it meanwhile.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      latest = await Order.findById(order._id).lean();
      const target = statusFromTickets(latest.tickets);
      const current = config.vendor.internalToVendorStatus[latest.status];
      if (!target || !VENDOR_STEPS.includes(current) || VENDOR_STEPS.indexOf(current) >= VENDOR_STEPS.indexOf(target)) break;
      const step = VENDOR_STEPS[VENDOR_STEPS.indexOf(current) + 1];
      try {
        await vendorOrderService.applyStatus(vendor, latest, step, { fromTickets: true });
      } catch (error) {
        if (error.code === 'ORDER_CHANGED') continue;
        // e.g. a scheduled order not due yet: the tickets stay ready, the order waits.
        note = error.message;
        break;
      }
    }
    latest = await Order.findById(order._id).lean();
    return { order: latest, note };
  }

  /**
   * The order itself moved (the owner changed it in Orders): tickets that
   * were behind catch up, and a cancelled order cancels its tickets.
   */
  async cascadeFromOrder(orderId, vendorStatus, actor = { type: 'system', name: 'System' }) {
    const order = await Order.findById(orderId).lean();
    if (!order?.tickets?.length) return;
    const now = new Date();
    if (vendorStatus === 'cancelled') {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: { 'tickets.$[t].status': 'cancelled', 'tickets.$[t].cancelled_at': now, 'items.$[].service_status': 'cancelled' },
          $push: { 'tickets.$[t].history': { status: 'cancelled', at: now, by: actor, note: 'Order cancelled' } },
        },
        { arrayFilters: [{ 't.status': { $ne: 'cancelled' } }] }
      );
      return;
    }
    const stage = { accepted: 'accepted', preparing: 'preparing', ready: 'ready' }[vendorStatus];
    if (!stage) return;
    const behind = Object.keys(STAGE_RANK).filter((s) => STAGE_RANK[s] < STAGE_RANK[stage]);
    const set = { 'tickets.$[t].status': stage };
    if (stage === 'ready') {
      set['tickets.$[t].ready_at'] = now;
      set['items.$[it].service_status'] = 'waiting_collection';
    }
    const arrayFilters = [{ 't.status': { $in: behind } }];
    if (stage === 'ready') arrayFilters.push({ 'it.service_status': 'pending' });
    await Order.updateOne(
      { _id: order._id, 'tickets.status': { $in: behind } },
      { $set: set, $push: { 'tickets.$[t].history': { status: stage, at: now, by: actor, note: 'Order updated' } } },
      { arrayFilters }
    );
  }
}

module.exports = new TicketService();
Object.assign(module.exports, { buildTickets, ensureTickets, statusFromTickets, serializeTicket, ticketProgress, paymentBlocks, TICKET_TO_VENDOR });

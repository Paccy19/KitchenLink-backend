const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { orderPrepMinutes } = require('../../utils/prepTime');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { isVendorLive } = require('../../utils/vendorPresence');
const { MenuItem, MenuItemOption, Order, Vendor, TableSession } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const vendorService = require('../vendorService');
const orderNotifications = require('../orderNotifications');
const departmentService = require('./departmentService');
const ticketService = require('./ticketService');
const invoiceService = require('./invoiceService');
const tableService = require('./tableService');
const diningSessionService = require('./diningSessionService');
const activity = require('./activityService');

const MAX_LINES = 40;
const MAX_QTY = 50;
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

const orderNumber = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `OFK-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

/** The table behind a scanned QR code, with its kitchen, or a plain-language 404 / 409. */
async function resolveTable(token) {
  const table = await tableService.findByToken(token);
  if (!table) {
    throw ApiError.notFound('This QR code is not linked to a table any more. Ask a member of staff for help.', 'TABLE_NOT_FOUND');
  }
  const vendor = await Vendor.findOne({ _id: table.vendor_id, deleted_at: null }).lean();
  if (!vendor || !vendor.is_active || vendor.verification_status !== 'approved') {
    throw ApiError.notFound('This kitchen is not taking orders on KitchenLink right now.', 'VENDOR_UNAVAILABLE');
  }
  return { table, vendor };
}

function orderingState(table, vendor) {
  if (!table.is_active) return { can_order: false, reason: 'This table is not taking orders right now. Ask a member of staff.' };
  if (vendor.operations?.table_ordering_enabled === false) return { can_order: false, reason: 'Ordering from the table is switched off. A server will take your order.' };
  if (!isVendorLive(vendor)) return { can_order: false, reason: 'The kitchen is closed right now.' };
  return { can_order: true, reason: null };
}

function guestView(order, departments, bill) {
  const labels = config.orders.dineInStatusLabels;
  return {
    id: String(order._id),
    order_number: order.order_number,
    status: order.status,
    status_label: labels[order.status] || config.orders.statusLabels[order.status] || order.status,
    table_label: order.table?.label || '',
    guest_name: order.guest?.name || '',
    placed_at: order.created_at,
    payment_status: order.payment_status,
    items: (order.items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      subtotal_rwf: item.subtotal_rwf,
      department_name: item.department_name || null,
      service_status: item.service_status || 'pending',
      service_status_label: access.SERVICE_STATUS_LABELS[item.service_status || 'pending'],
      options: (item.options || []).map((o) => o.name),
      note: item.note || '',
    })),
    departments: ticketService.ticketProgress(order, departments),
    subtotal_rwf: order.subtotal_rwf,
    total_rwf: order.total_rwf,
    bill,
  };
}

class TableOrderService {
  /** GET /tables/:token — the kitchen's whole menu (every active department) for this table. */
  async menu(token) {
    const { table, vendor } = await resolveTable(token);
    const [storefront, departments] = await Promise.all([
      vendorService.getStorefront(String(vendor._id)),
      departmentService.listForVendor(vendor._id, { includeInactive: false }),
    ]);
    const timing = vendor.operations?.payment_timing || 'after_service';
    return {
      table: {
        label: table.label,
        area: table.area || '',
        ...(table._qr_seat_number ? { seat: { number: table._qr_seat_number } } : {}),
      },
      kitchen: storefront,
      departments: departments.map(departmentService.serializePublic),
      promotions: await require('./promotionService').publicCampaigns(vendor._id),
      ordering: {
        ...orderingState(table, vendor),
        payment_timing: timing,
        payment_timing_label: access.PAYMENT_TIMINGS.find((t) => t.id === timing)?.label || '',
        pay_before_preparation: access.paymentGate(timing) === 'preparation',
      },
    };
  }

  async openSession(token, body = {}, customer = null, sessionKey = null) {
    const { table, vendor } = await resolveTable(token);
    const state = orderingState(table, vendor);
    if (!state.can_order) {
      const { tableSession, customerSession } = await diningSessionService.requireOwned(table, customer, sessionKey);
      return {
        table_session_id: String(tableSession._id),
        customer_session_id: String(customerSession._id),
        seat_number: customerSession.seat_number,
        guest_name: customerSession.guest_name || '',
        status: customerSession.status,
        expires_at: customerSession.expires_at,
        session_key: sessionKey || null,
      };
    }
    return diningSessionService.open(table, vendor, body, customer, sessionKey);
  }

  parseLines(body) {
    const raw = body?.items;
    if (!Array.isArray(raw) || raw.length === 0) throw ApiError.badRequest('Add something to your order first.', { items: 'expected at least one item' });
    if (raw.length > MAX_LINES) throw ApiError.badRequest(`At most ${MAX_LINES} different items per order.`, { items: 'too many lines' });
    return raw.map((line, index) => {
      const quantity = Number(line?.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
        throw ApiError.badRequest(`Quantities are 1 to ${MAX_QTY}.`, { [`items[${index}].quantity`]: `expected 1-${MAX_QTY}` });
      }
      const optionIds = Array.isArray(line?.option_ids) ? [...new Set(line.option_ids.map(String))] : [];
      if (optionIds.length > 15 || optionIds.some((id) => !mongoose.isValidObjectId(id))) {
        throw ApiError.badRequest('Some options are not valid.', { [`items[${index}].option_ids`]: 'expected option ids' });
      }
      return {
        menu_item_id: parseObjectId(line?.menu_item_id, `items[${index}].menu_item_id`),
        quantity,
        option_ids: optionIds,
        note: parseOptionalText(line?.note, { field: `items[${index}].note`, max: 140 }) || '',
        takeaway: line?.takeaway === true,
      };
    });
  }

  /**
   * POST /tables/:token/orders — one order from the table, whatever
   * departments its dishes come from. The server prices it; each department
   * gets a ticket with only its dishes; the order joins the table's bill.
   */
  async placeOrder(token, body = {}, customer = null, sessionKey = null) {
    const { table, vendor } = await resolveTable(token);
    const state = orderingState(table, vendor);
    if (!state.can_order) throw ApiError.conflict(state.reason, 'TABLE_ORDERING_UNAVAILABLE');
    const diningSession = await diningSessionService.requireOwned(table, customer, sessionKey);
    if (diningSession && await Order.exists({
      table_session_id: diningSession.tableSession._id,
      customer_session_id: diningSession.customerSession._id,
      status: { $ne: 'cancelled' },
      payment_lock_id: { $ne: null },
    })) {
      throw ApiError.conflict('A payment is being processed for this seat. Wait for its result before adding another order.', 'SEAT_PAYMENT_PENDING');
    }
    const lines = this.parseLines(body);
    const requestedName = parseOptionalText(body.guest_name, { field: 'guest_name', max: 40 }) || '';
    const guestName = diningSession?.customerSession.guest_name || requestedName || customer?.name || '';
    if (diningSession && requestedName && !diningSession.customerSession.guest_name) {
      await TableSession.updateOne(
        { _id: diningSession.tableSession._id, 'customer_sessions._id': diningSession.customerSession._id },
        { $set: { 'customer_sessions.$.guest_name': requestedName } }
      );
    }
    // A seat QR order belongs to that guest's seat in the table's visit; a table
    // QR order joins the visit (opened now if the guests scanned before being seated).
    const session = diningSession?.tableSession || (await require('./sessionService').liveForTable(table, { source: 'qr' }));
    const { order, guestKey } = await this.createDineInOrder({
      vendor,
      table,
      session,
      seat: diningSession?.customerSession || null,
      lines,
      guestName,
      note: parseOptionalText(body.note, { field: 'note', max: 300 }) || '',
      customer,
      source: 'table_qr',
      actor: { type: 'customer', id: customer ? String(customer._id) : null, name: guestName || 'Guest' },
    });
    return { ...(await this.#view(order._id)), guest_key: guestKey };
  }

  /**
   * One dine-in order for a table visit, priced on the server and split into
   * department tickets; it joins the visit's bill. Used by guests (QR), by
   * servers taking an order, and by reservations' pre-orders.
   */
  async createDineInOrder({ vendor, table, session = null, seat = null, lines, guestName = '', note = '', customer = null, source = 'table_qr', actor, reservationId = null }) {
    const dishIds = [...new Set(lines.map((l) => String(l.menu_item_id)))];
    const [dishes, options] = await Promise.all([
      MenuItem.find({ _id: { $in: dishIds }, vendor_id: vendor._id, deleted_at: null }).lean(),
      MenuItemOption.find({ menu_item_id: { $in: dishIds }, vendor_id: vendor._id, deleted_at: null, is_available: { $ne: false } }).lean(),
    ]);
    const dishById = new Map(dishes.map((d) => [String(d._id), d]));
    const optionById = new Map(options.map((o) => [String(o._id), o]));
    const unavailable = [];
    const items = lines.map((line) => {
      const dish = dishById.get(String(line.menu_item_id));
      if (!dish || !dish.is_available) {
        unavailable.push(dish?.name || 'an item');
        return null;
      }
      const chosen = (line.option_ids || []).map((id) => optionById.get(String(id)));
      if (chosen.some((o) => !o || String(o.menu_item_id) !== String(dish._id))) {
        throw ApiError.conflict(`Some options for ${dish.name} are no longer available.`, 'OPTION_UNAVAILABLE');
      }
      const unit = dish.price_rwf + chosen.reduce((sum, o) => sum + (o.additional_price_rwf || 0), 0);
      return {
        menu_item_id: dish._id,
        name: dish.name,
        price_rwf: unit,
        quantity: line.quantity,
        subtotal_rwf: unit * line.quantity,
        image_url: dish.image_url || '',
        note: line.note || '',
        takeaway: Boolean(line.takeaway),
        options: chosen.map((o) => ({ option_id: o._id, group_name: o.group_name || 'Options', name: o.name, additional_price_rwf: o.additional_price_rwf || 0 })),
      };
    });
    if (unavailable.length) {
      throw ApiError.conflict(`These items are no longer available: ${unavailable.join(', ')}.`, 'CART_ITEM_UNAVAILABLE');
    }
    const subtotal = items.reduce((sum, item) => sum + item.subtotal_rwf, 0);
    const prepMinutes = orderPrepMinutes(lines.map((l) => dishById.get(String(l.menu_item_id))), vendor);
    const number = orderNumber();
    const split = await ticketService.buildTickets(vendor._id, items, number);
    const guestKey = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const timing = vendor.operations?.payment_timing || 'after_service';
    const order = (
      await Order.create({
        order_number: number,
        customer_id: customer?._id || null,
        vendor_id: vendor._id,
        items: split.items,
        tickets: split.tickets,
        subtotal_rwf: subtotal,
        delivery_fee_rwf: 0,
        total_rwf: subtotal,
        fulfillment: 'dine_in',
        source: 'table_qr',
        table: { table_id: table._id, label: table.label, seat_number: seat?.seat_number ?? null },
        table_session_id: session?._id || null,
        customer_session_id: seat?._id || null,
        reservation_id: reservationId,
        assigned_staff: session?.server_id ? { type: 'staff', id: String(session.server_id), name: session.server_name } : null,
        guest: { name: guestName || session?.customer_name || '', key_hash: hashKey(guestKey) },
        delivery_location: { note },
        payment_method: 'in_person',
        payment_status: 'pending',
        payment_gate: access.paymentGate(timing),
        order_type: 'immediate',
        status: 'placed',
        status_history: [{ status: 'placed', at: now, note: source === 'staff' ? `Taken at ${table.label} by ${actor?.name || 'staff'}` : source === 'reservation' ? `Pre-order for ${table.label}` : `Ordered at ${table.label}` }],
        eta_minutes: prepMinutes,
        prep_minutes: prepMinutes,
        estimated_delivery_at: new Date(now.getTime() + prepMinutes * 60000),
      })
    ).toObject();

    if (session) await require('./sessionService').attachOrder(session, order);
    await invoiceService.attachDineInOrder(order, table, session);
    // A booking's paid deposit counts on the bill as soon as there is something to pay.
    if (session?.reservation_id) await require('./reservationService').applyDeposit(session.reservation_id);
    // New items "to take away" are billed like any other, then packed when ready.
    await require('./packingService').forNewTakeawayItems(order, actor || { type: 'customer', name: guestName || 'Guest' });
    orderNotifications.newOrder(order);
    activity.recordSystem(
      vendor._id,
      { action: source === 'staff' ? 'order.taken_by_server' : 'order.table_placed', target_type: 'order', target_id: order._id, summary: `${table.label} ordered ${order.order_number} (RWF ${subtotal.toLocaleString('en-US')})` },
      actor || { type: 'customer', id: null, name: guestName || 'Guest' }
    );
    return { order, guestKey };
  }

  async #view(orderId) {
    const order = await Order.findById(orderId).lean();
    const departments = new Map((await departmentService.listForVendor(order.vendor_id)).map((d) => [String(d._id), d]));
    return { order: guestView(order, departments, await invoiceService.publicForOrder(order)) };
  }

  async request(token, body = {}) {
    const { table } = await resolveTable(token);
    if (!table.is_active) throw ApiError.conflict('This table is not taking requests right now.', 'TABLE_INACTIVE');
    return require('./serviceRequestService').create(table, body);
  }

  async openRequests(token) {
    const { table } = await resolveTable(token);
    return { requests: await require('./serviceRequestService').openForTable(table) };
  }

  async feedback(token, orderId, key, body = {}, customer = null) {
    await this.getOrder(token, orderId, key, customer);
    const order = await Order.findById(orderId).lean();
    return require('./customerService').leaveFeedback(order, body);
  }

  /** GET /tables/:token/orders/:id?key= — a guest following their order (the key proves it's theirs). */
  async getOrder(token, orderId, key, customer = null) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await Order.findOne({ _id: id, fulfillment: 'dine_in' }).select('+guest.key_hash').lean();
    const table = await tableService.findByToken(token);
    const sameTable = order && table && String(order.table?.table_id) === String(table._id);
    const ownsByAccount = order && customer && order.customer_id && String(order.customer_id) === String(customer._id);
    let ownsByKey = false;
    if (order && typeof key === 'string' && key && order.guest?.key_hash) {
      const a = Buffer.from(hashKey(key));
      const b = Buffer.from(order.guest.key_hash);
      ownsByKey = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!order || !(ownsByAccount || (sameTable && ownsByKey))) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    return this.#view(order._id);
  }
}

module.exports = new TableOrderService();

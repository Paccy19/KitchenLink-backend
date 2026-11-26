const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { Order, MenuItem, MenuItemOption, KitchenStaff, DiningTable, Invoice, KitchenActivity } = require('../../models');
const config = require('../../config');
const ticketService = require('./ticketService');
const invoiceService = require('./invoiceService');
const departmentService = require('./departmentService');
const activity = require('./activityService');
const alerts = require('./alertService');

const { ObjectId } = mongoose.Types;
const CLOSED = ['delivered', 'cancelled'];
const PRIORITIES = ['normal', 'high', 'urgent'];

const anyOf = (kitchen, permissions, departmentId) => {
  if (!permissions.some((p) => kitchen.can(p, departmentId))) kitchen.assert(permissions[0], departmentId);
};

/**
 * What staff can do to an order beyond moving it along: priority, who looks
 * after it, editing its items (bills paid in person only: an app order was
 * charged online and changes would need a refund), its table, reopening it,
 * and the kitchen's own couriers.
 */
class OrderOpsService {
  async #load(kitchen, orderId) {
    const id = parseObjectId(orderId, 'order_id');
    let order = await Order.findOne({ _id: id, vendor_id: kitchen.vendorId }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    order = await ticketService.ensureTickets(order);
    return order;
  }

  async #staff(kitchen, staffId, field = 'staff_id') {
    const id = parseObjectId(staffId, field);
    const staff = await KitchenStaff.findOne({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null, is_active: true }).lean();
    if (!staff) throw ApiError.badRequest('That employee is not an active member of this kitchen.', { [field]: 'unknown employee' });
    return staff;
  }

  #assertOpen(order) {
    if (CLOSED.includes(order.status)) {
      throw ApiError.conflict(`This order is already ${order.status === 'cancelled' ? 'cancelled' : 'completed'}.`, 'ORDER_CLOSED');
    }
  }

  /** Item changes change the price: only for bills the kitchen collects itself, before payment. */
  #assertEditable(order) {
    this.#assertOpen(order);
    if (order.payment_method !== 'in_person') {
      throw ApiError.conflict('This order was paid in the app, so its items can no longer change. Cancel it to refund the customer instead.', 'ORDER_PAID_ONLINE');
    }
    if (order.payment_status === 'paid') {
      throw ApiError.conflict('This bill is already paid. Start a new order for anything extra.', 'ORDER_ALREADY_PAID');
    }
  }

  async #saveItems(order, items, tickets, note, kitchen) {
    const subtotal = items.filter((i) => i.service_status !== 'cancelled').reduce((sum, i) => sum + i.subtotal_rwf, 0);
    const saved = await Order.findOneAndUpdate(
      { _id: order._id, updated_at: order.updated_at },
      {
        $set: { items, tickets, subtotal_rwf: subtotal, total_rwf: subtotal + (order.delivery_fee_rwf || 0) },
        $push: { status_history: { status: order.status, at: new Date(), note } },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This order was just changed by someone else. Refresh and try again.', 'ORDER_CHANGED');
    await invoiceService.syncOrderLines(order._id);
    activity.record(kitchen, { action: 'order.edited', target_type: 'order', target_id: order._id, summary: `${order.order_number}: ${note}` });
    const vendor = await mongoose.model('Vendor').findById(order.vendor_id);
    await ticketService.syncParent(vendor, saved);
    return Order.findById(order._id).lean();
  }

  /** The ticket an item goes to: its department's open ticket, or a new one. */
  #ticketFor(order, tickets, department) {
    const key = department ? String(department._id) : null;
    const open = tickets.find((t) => String(t.department_id || '') === String(key || '') && ['pending', 'accepted', 'preparing'].includes(t.status));
    if (open) return open;
    const ticket = {
      _id: new ObjectId(),
      department_id: department ? department._id : null,
      department_name: department ? department.name : 'Kitchen',
      code: `${department ? department.code_prefix || 'X' : 'K'}${String(order.order_number).split('-').pop()}-${tickets.length + 1}`,
      status: 'pending',
      history: [{ status: 'pending', at: new Date(), by: { type: 'system', name: 'System' }, note: 'Added to the order' }],
    };
    tickets.push(ticket);
    return ticket;
  }

  async priority(kitchen, orderId, body = {}) {
    kitchen.assert('orders.priorities');
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    const priority = String(body.priority || '');
    if (!PRIORITIES.includes(priority)) throw ApiError.badRequest('Priority is normal, high or urgent.', { priority: 'expected normal, high or urgent' });
    await Order.updateOne({ _id: order._id }, { $set: { priority } });
    activity.record(kitchen, { action: 'order.priority', target_type: 'order', target_id: order._id, summary: `${order.order_number} set to ${priority} priority` });
    if (priority === 'urgent') alerts.emit(kitchen.vendorId, 'order_alerts', { title: `Urgent: ${order.order_number}`, body: order.table?.label ? `For ${order.table.label}` : 'Marked urgent', link: '/vendor-dashboard/kitchen', permission: 'kitchen.view_queue' });
    return this.view(kitchen, order._id);
  }

  /** Who looks after the order (a server, a coordinator). Moving it to someone else is a transfer. */
  async assign(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    anyOf(kitchen, order.assigned_staff ? ['orders.assign_employees', 'service.transfer_servers', 'service.assign_servers'] : ['orders.assign_employees', 'service.assign_servers']);
    let assigned = null;
    if (body.staff_id) {
      const staff = await this.#staff(kitchen, body.staff_id);
      assigned = { type: 'staff', id: String(staff._id), name: staff.name };
    }
    await Order.updateOne({ _id: order._id }, { $set: { assigned_staff: assigned } });
    activity.record(kitchen, {
      action: 'order.assigned',
      target_type: 'order',
      target_id: order._id,
      summary: assigned ? `${order.order_number} given to ${assigned.name}` : `${order.order_number} no longer assigned`,
    });
    if (assigned) alerts.toStaff(kitchen.vendorId, assigned.id, { title: `${order.order_number} is yours`, body: order.table?.label || config.orders.fulfillmentLabels[order.fulfillment || 'delivery'], link: '/vendor-dashboard/service' });
    return this.view(kitchen, order._id);
  }

  async addItem(kitchen, orderId, body = {}) {
    anyOf(kitchen, ['orders.add_items', 'orders.edit']);
    const order = await this.#load(kitchen, orderId);
    this.#assertEditable(order);
    const dish = await MenuItem.findOne({ _id: parseObjectId(body.menu_item_id, 'menu_item_id'), vendor_id: order.vendor_id, deleted_at: null }).lean();
    if (!dish || !dish.is_available) throw ApiError.conflict('That dish is not available.', 'MENU_ITEM_UNAVAILABLE');
    const quantity = Number(body.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw ApiError.badRequest('Quantities are 1 to 50.', { quantity: 'expected 1-50' });
    const optionIds = Array.isArray(body.option_ids) ? body.option_ids.map(String) : [];
    const options = optionIds.length ? await MenuItemOption.find({ _id: { $in: optionIds }, menu_item_id: dish._id, deleted_at: null }).lean() : [];
    if (options.length !== optionIds.length) throw ApiError.conflict('Some options are not available.', 'OPTION_UNAVAILABLE');
    const departments = await departmentService.activeMap(order.vendor_id);
    const department = dish.department_id ? departments.get(String(dish.department_id)) : null;
    const tickets = order.tickets.map((t) => ({ ...t }));
    const ticket = this.#ticketFor(order, tickets, department || null);
    const unit = dish.price_rwf + options.reduce((s, o) => s + (o.additional_price_rwf || 0), 0);
    const items = [
      ...order.items,
      {
        _id: new ObjectId(),
        menu_item_id: dish._id,
        name: dish.name,
        price_rwf: unit,
        quantity,
        subtotal_rwf: unit * quantity,
        image_url: dish.image_url || '',
        note: parseOptionalText(body.note, { field: 'note', max: 140 }) || '',
        // Dine-in guests can add something to take away: billed, then packed.
        takeaway: body.takeaway === true && order.fulfillment === 'dine_in',
        department_id: ticket.department_id,
        department_name: ticket.department_name,
        ticket_id: ticket._id,
        service_status: 'pending',
        options: options.map((o) => ({ option_id: o._id, group_name: o.group_name || 'Options', name: o.name, additional_price_rwf: o.additional_price_rwf || 0 })),
      },
    ];
    // A ready order getting something new is being prepared again.
    const saved = await this.#saveItems(order, items, tickets, `Added ${quantity}× ${dish.name}`, kitchen);
    if (saved.status === 'ready') {
      await Order.updateOne({ _id: order._id, status: 'ready' }, { $set: { status: 'preparing' }, $push: { status_history: { status: 'preparing', at: new Date(), note: 'More items added' } } });
    }
    const added = items[items.length - 1];
    if (added.takeaway) await require('./packingService').forNewTakeawayItems({ ...order, items: [added] }, kitchen.actor);
    return this.view(kitchen, order._id);
  }

  async #itemOf(order, itemId) {
    const id = parseObjectId(itemId, 'item_id');
    const item = order.items.find((i) => String(i._id) === String(id));
    if (!item || item.service_status === 'cancelled') throw ApiError.notFound('Item not found on this order.', 'ORDER_ITEM_NOT_FOUND');
    return item;
  }

  async setQuantity(kitchen, orderId, itemId, body = {}) {
    anyOf(kitchen, ['orders.quantities', 'orders.edit']);
    const order = await this.#load(kitchen, orderId);
    this.#assertEditable(order);
    const item = await this.#itemOf(order, itemId);
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw ApiError.badRequest('Quantities are 1 to 50.', { quantity: 'expected 1-50' });
    if (item.service_status !== 'pending') throw ApiError.conflict('This item is already prepared; add a new one instead.', 'ITEM_PREPARED');
    const items = order.items.map((i) => (String(i._id) === String(item._id) ? { ...i, quantity, subtotal_rwf: i.price_rwf * quantity } : i));
    await this.#saveItems(order, items, order.tickets, `${item.name}: ${item.quantity} → ${quantity}`, kitchen);
    return this.view(kitchen, order._id);
  }

  async removeItem(kitchen, orderId, itemId) {
    anyOf(kitchen, ['orders.remove_items', 'orders.edit']);
    const order = await this.#load(kitchen, orderId);
    this.#assertEditable(order);
    const item = await this.#itemOf(order, itemId);
    const live = order.items.filter((i) => i.service_status !== 'cancelled');
    if (live.length <= 1) throw ApiError.conflict('This is the last item: cancel the order instead.', 'LAST_ITEM');
    const items = order.items.map((i) => (String(i._id) === String(item._id) ? { ...i, service_status: 'cancelled' } : i));
    // A ticket with nothing left is cancelled.
    const tickets = order.tickets.map((t) =>
      items.some((i) => String(i.ticket_id) === String(t._id) && i.service_status !== 'cancelled') ? t : { ...t, status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Items removed' }
    );
    await this.#saveItems(order, items, tickets, `Removed ${item.quantity}× ${item.name}`, kitchen);
    return this.view(kitchen, order._id);
  }

  /** Sends an item to another department (before it is prepared). */
  async moveItem(kitchen, orderId, itemId, body = {}) {
    kitchen.assert('orders.assign_departments');
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    const item = await this.#itemOf(order, itemId);
    if (item.service_status !== 'pending') throw ApiError.conflict('This item is already prepared.', 'ITEM_PREPARED');
    const target = await departmentService.resolveId(kitchen.vendorId, body.department_id ?? null);
    const department = target ? (await departmentService.activeMap(kitchen.vendorId)).get(String(target)) : null;
    if (target && !department) throw ApiError.badRequest('That department is switched off.', { department_id: 'inactive department' });
    const tickets = order.tickets.map((t) => ({ ...t }));
    const ticket = this.#ticketFor(order, tickets, department);
    const items = order.items.map((i) =>
      String(i._id) === String(item._id) ? { ...i, department_id: ticket.department_id, department_name: ticket.department_name, ticket_id: ticket._id } : i
    );
    const finalTickets = tickets.map((t) =>
      items.some((i) => String(i.ticket_id) === String(t._id) && i.service_status !== 'cancelled') ? t : { ...t, status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Items moved' }
    );
    const saved = await Order.findOneAndUpdate(
      { _id: order._id, updated_at: order.updated_at },
      { $set: { items, tickets: finalTickets }, $push: { status_history: { status: order.status, at: new Date(), note: `${item.name} sent to ${ticket.department_name}` } } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This order was just changed by someone else. Refresh and try again.', 'ORDER_CHANGED');
    await invoiceService.syncOrderLines(order._id);
    activity.record(kitchen, { action: 'order.item_moved', target_type: 'order', target_id: order._id, summary: `${order.order_number}: ${item.name} → ${ticket.department_name}` });
    return this.view(kitchen, order._id);
  }

  /**
   * Reopens a completed dine-in order (forgotten item, mistake) or a
   * cancelled one paid in person with nothing paid yet. App orders, whose
   * money went back to the customer, can't be reopened.
   */
  async reopen(kitchen, orderId, body = {}) {
    anyOf(kitchen, ['orders.reopen', 'kitchen.completed']);
    const order = await this.#load(kitchen, orderId);
    const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 }) || 'Reopened';
    const now = new Date();
    if (order.status === 'delivered' && order.fulfillment === 'dine_in') {
      if (now - new Date(order.completed_at || order.updated_at) > 24 * 3600 * 1000) {
        throw ApiError.conflict('Orders can only be reopened within 24 hours.', 'REOPEN_TOO_LATE');
      }
      await Order.updateOne(
        { _id: order._id, status: 'delivered' },
        { $set: { status: 'ready', completed_at: null, delivered_at: null, reopened_at: now }, $push: { status_history: { status: 'ready', at: now, note: reason } } }
      );
    } else if (order.status === 'cancelled' && order.payment_method === 'in_person' && order.payment_status !== 'paid') {
      const items = order.items.map((i) => ({ ...i, service_status: 'pending' }));
      const tickets = order.tickets.map((t) => ({ ...t, status: 'pending', cancelled_at: null, history: [...(t.history || []), { status: 'pending', at: now, by: kitchen.actor, note: reason }] }));
      await Order.updateOne(
        { _id: order._id, status: 'cancelled' },
        { $set: { status: 'placed', items, tickets, cancelled_at: null, cancel_reason: '', reopened_at: now }, $push: { status_history: { status: 'placed', at: now, note: reason } } }
      );
      if (order.invoice_id) {
        await Invoice.updateOne({ _id: order.invoice_id }, { $set: { 'lines.$[l].voided': false } }, { arrayFilters: [{ 'l.order_id': new ObjectId(String(order._id)) }] });
        await invoiceService.recalc(order.invoice_id);
      }
    } else {
      throw ApiError.conflict('Only completed dine-in orders, or cancelled ones not yet paid, can be reopened.', 'ORDER_NOT_REOPENABLE');
    }
    activity.record(kitchen, { action: 'order.reopened', target_type: 'order', target_id: order._id, summary: `Reopened ${order.order_number}: ${reason}` });
    return this.view(kitchen, order._id);
  }

  /** Everything that happened to an order: its status changes, ticket steps and staff actions. */
  async history(kitchen, orderId) {
    anyOf(kitchen, ['audit.order_history', 'orders.details', 'orders.view']);
    const order = await this.#load(kitchen, orderId);
    const entries = await KitchenActivity.find({ vendor_id: kitchen.vendorId, target_type: 'order', target_id: String(order._id) }).sort({ created_at: 1 }).lean();
    const timeline = [
      ...(order.status_history || []).map((h) => ({ at: h.at, kind: 'status', text: h.note || config.orders.statusLabels[h.status] || h.status, by: null })),
      ...(order.tickets || []).flatMap((t) => (t.history || []).map((h) => ({ at: h.at, kind: 'ticket', text: `${t.code} (${t.department_name}): ${h.status}${h.note ? ` · ${h.note}` : ''}`, by: h.by?.name || null }))),
      ...entries.map((e) => ({ at: e.created_at, kind: 'action', text: e.summary, by: e.actor_name })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    return { order_id: String(order._id), order_number: order.order_number, timeline };
  }

  /** Puts an order at a table, or moves it from one table to another (with its bill lines). */
  async setTable(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    anyOf(kitchen, order.table?.table_id ? ['tables.transfer_orders'] : ['tables.assign_orders']);
    const table = await DiningTable.findOne({ _id: parseObjectId(body.table_id, 'table_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    if (!table.is_active) throw ApiError.conflict('That table is switched off.', 'TABLE_INACTIVE');
    if (String(order.table?.table_id) === String(table._id)) return this.view(kitchen, order._id);
    const from = order.table?.label || null;
    await Order.updateOne(
      { _id: order._id },
      { $set: { table: { table_id: table._id, label: table.label } }, $push: { status_history: { status: order.status, at: new Date(), note: from ? `Moved from ${from} to ${table.label}` : `Served at ${table.label}` } } }
    );
    // A bill paid in person follows the order to the new table's open bill.
    if (order.payment_method === 'in_person' && order.invoice_id) {
      const oldInvoice = await Invoice.findById(order.invoice_id).lean();
      if (oldInvoice && !oldInvoice.amount_paid_rwf) {
        const oid = new ObjectId(String(order._id));
        await Invoice.updateOne({ _id: oldInvoice._id }, { $pull: { lines: { order_id: oid }, order_ids: oid } });
        const after = await invoiceService.recalc(oldInvoice._id);
        if (after && !after.order_ids.length) await Invoice.updateOne({ _id: after._id }, { $set: { status: 'void', is_open: false, cancel_reason: `Moved to ${table.label}` } });
        await Order.updateOne({ _id: order._id }, { $set: { invoice_id: null } });
        await invoiceService.attachDineInOrder({ ...(await Order.findById(order._id).lean()) }, table);
      }
    }
    activity.record(kitchen, { action: 'order.table_changed', target_type: 'order', target_id: order._id, summary: from ? `${order.order_number} moved from ${from} to ${table.label}` : `${order.order_number} assigned to ${table.label}` });
    return this.view(kitchen, order._id);
  }

  /** A server takes the collection task for an order's ready items. */
  async claim(kitchen, orderId) {
    kitchen.assert('service.accept_collection');
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, $or: [{ collector: null }, { 'collector.id': kitchen.actor.id }] },
      { $set: { collector: kitchen.actor } },
      { returnDocument: 'after' }
    ).lean();
    if (!claimed) throw ApiError.conflict(`${order.collector?.name || 'Someone else'} is already collecting this order.`, 'ALREADY_CLAIMED');
    activity.record(kitchen, { action: 'service.claimed', target_type: 'order', target_id: order._id, summary: `${kitchen.actor.name} is collecting ${order.order_number}` });
    return this.view(kitchen, order._id);
  }

  // ------------------------------------------------- the kitchen's own couriers

  #assertKitchenDelivers(order) {
    if (!['vendor_delivery', 'delivery'].includes(order.fulfillment || 'delivery')) {
      throw ApiError.conflict('Only delivery orders get a courier.', 'NOT_A_DELIVERY');
    }
    if (order.fulfillment === 'delivery' && order.driver_id) {
      throw ApiError.conflict('A KitchenLink delivery worker already has this order.', 'DRIVER_ASSIGNED');
    }
    if (order.fulfillment === 'delivery') {
      throw ApiError.conflict('KitchenLink delivery workers take this order automatically. Your own couriers deliver the orders you bring yourself.', 'PLATFORM_DELIVERY');
    }
  }

  async setCourier(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    this.#assertOpen(order);
    this.#assertKitchenDelivers(order);
    anyOf(kitchen, order.kitchen_courier ? ['delivery.change_assignments', 'delivery.assign_workers'] : ['delivery.create_assignments', 'delivery.assign_workers']);
    const staff = await this.#staff(kitchen, body.staff_id);
    const courier = { staff_id: staff._id, name: staff.name, status: 'assigned', assigned_at: new Date(), updated_at: new Date() };
    await Order.updateOne({ _id: order._id }, { $set: { kitchen_courier: courier }, $push: { status_history: { status: order.status, at: new Date(), note: `${staff.name} will deliver it` } } });
    activity.record(kitchen, { action: 'delivery.assigned', target_type: 'order', target_id: order._id, summary: `${staff.name} delivers ${order.order_number}` });
    alerts.toStaff(kitchen.vendorId, String(staff._id), { title: `Deliver ${order.order_number}`, body: order.delivery_location?.address || '', link: '/vendor-dashboard/service' });
    return this.view(kitchen, order._id);
  }

  async cancelCourier(kitchen, orderId) {
    anyOf(kitchen, ['delivery.cancel_assignments']);
    const order = await this.#load(kitchen, orderId);
    if (!order.kitchen_courier) throw ApiError.conflict('No courier is assigned.', 'NO_COURIER');
    await Order.updateOne({ _id: order._id }, { $set: { kitchen_courier: null }, $push: { status_history: { status: order.status, at: new Date(), note: 'Courier unassigned' } } });
    activity.record(kitchen, { action: 'delivery.unassigned', target_type: 'order', target_id: order._id, summary: `No courier for ${order.order_number} any more` });
    return this.view(kitchen, order._id);
  }

  /**
   * The kitchen's own courier moves the delivery along:
   *   assigned -> acknowledged -> collected -> in_transit -> (customer's code) delivered
   *   collected / in_transit -> failed or customer_unavailable -> in_transit (retry) or returned
   * The courier changes their own deliveries; a coordinator can change any.
   * Only the customer's code completes it (and nobody marks it paid here).
   */
  async courierStatus(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    if (!order.kitchen_courier) throw ApiError.conflict('No courier is assigned.', 'NO_COURIER');
    const mine = kitchen.actor.type === 'staff' && String(order.kitchen_courier.staff_id) === kitchen.actor.id;
    if (!mine) anyOf(kitchen, ['delivery.change_assignments', 'delivery.track']);
    let status = String(body.status || '');
    if (status === 'on_the_way') status = 'in_transit';
    const current = order.kitchen_courier.status === 'on_the_way' ? 'in_transit' : order.kitchen_courier.status;
    const NEXT = {
      // Leaving straight away counts as collecting the food too.
      assigned: ['acknowledged', 'collected', 'in_transit'],
      acknowledged: ['collected', 'in_transit'],
      collected: ['in_transit', 'failed', 'customer_unavailable', 'returned'],
      in_transit: ['failed', 'customer_unavailable', 'returned'],
      failed: ['in_transit', 'returned'],
      customer_unavailable: ['in_transit', 'returned'],
    };
    const allowed = NEXT[current] || [];
    if (!allowed.includes(status)) {
      throw ApiError.conflict(
        allowed.length ? `From "${current.replace('_', ' ')}" the delivery can go to: ${allowed.join(', ')}. The customer's code completes it.` : 'This delivery is finished.',
        'INVALID_COURIER_STATUS'
      );
    }
    if (status === 'collected' || (status === 'in_transit' && ['assigned', 'acknowledged'].includes(current))) {
      if (!['ready', 'assigned'].includes(order.status)) throw ApiError.conflict('The order is not ready yet.', 'ORDER_NOT_READY');
      if (!(await require('./packingService').isPacked(order._id))) throw ApiError.conflict('The order is still at the packing station.', 'NOT_PACKED');
    }
    const note = parseOptionalText(body.note, { field: 'note', max: 200 }) || '';
    if (['failed', 'customer_unavailable', 'returned'].includes(status) && !note) {
      throw ApiError.badRequest('Say what happened.', { note: 'required' });
    }
    const now = new Date();
    const label = { acknowledged: 'accepted the delivery', collected: 'collected the food', in_transit: 'is on the way', failed: 'could not deliver', customer_unavailable: 'could not reach the customer', returned: 'brought the food back' }[status];
    const done = await Order.updateOne(
      { _id: order._id, 'kitchen_courier.status': order.kitchen_courier.status },
      {
        $set: { 'kitchen_courier.status': status, 'kitchen_courier.updated_at': now },
        $push: {
          status_history: { status: order.status, at: now, note: `${order.kitchen_courier.name} ${label}${note ? `: ${note}` : ''}` },
          ...(['failed', 'customer_unavailable', 'returned'].includes(status) ? { 'kitchen_courier.attempts': { at: now, outcome: status, note } } : {}),
        },
      }
    );
    if (!done.modifiedCount) throw ApiError.conflict('This delivery just changed. Refresh and try again.', 'COURIER_CHANGED');
    if (['failed', 'customer_unavailable', 'returned'].includes(status)) {
      alerts.emit(kitchen.vendorId, 'deliveries', { title: `${order.order_number}: ${label}`, body: note, link: '/vendor-dashboard/deliveries', permission: 'delivery.change_assignments' });
    }
    if (['collected', 'in_transit'].includes(status) && order.customer_id) {
      require('../notificationService')
        .notifyCustomers([order.customer_id], { type: 'order_update', title: status === 'collected' ? 'Your order has left the kitchen' : 'Your order is on the way', body: `${order.kitchen_courier.name} is bringing ${order.order_number}.`, link: `/orders/${order._id}` })
        .catch(() => null);
    }
    activity.record(kitchen, { action: `delivery.${status}`, target_type: 'order', target_id: order._id, summary: `${order.order_number}: ${order.kitchen_courier.name} ${label}` });
    if (mine && !kitchen.can('delivery.track') && !kitchen.can('orders.view')) {
      // A kitchen driver sees their delivery, not the order's money.
      const fresh = await Order.findById(order._id).select('order_number status kitchen_courier').lean();
      return { id: String(fresh._id), order_number: fresh.order_number, status: fresh.status, kitchen_courier: { staff_id: String(fresh.kitchen_courier.staff_id), name: fresh.kitchen_courier.name, status: fresh.kitchen_courier.status } };
    }
    return this.view(kitchen, order._id);
  }

  async view(kitchen, orderId) {
    const order = await Order.findById(orderId).lean();
    return {
      id: String(order._id),
      order_number: order.order_number,
      status: order.status,
      priority: order.priority || 'normal',
      assigned_staff: order.assigned_staff?.name ? { id: order.assigned_staff.id, name: order.assigned_staff.name } : null,
      collector: order.collector?.name ? { id: order.collector.id, name: order.collector.name } : null,
      kitchen_courier: order.kitchen_courier ? { staff_id: String(order.kitchen_courier.staff_id), name: order.kitchen_courier.name, status: order.kitchen_courier.status } : null,
      table: order.table?.table_id ? { id: String(order.table.table_id), label: order.table.label } : null,
      subtotal_rwf: order.subtotal_rwf,
      total_rwf: order.total_rwf,
      tickets: ticketService.ticketProgress(order),
      items: (order.items || []).map((i) => ({ id: String(i._id), name: i.name, quantity: i.quantity, subtotal_rwf: i.subtotal_rwf, department_name: i.department_name, service_status: i.service_status })),
    };
  }
}

module.exports = new OrderOpsService();

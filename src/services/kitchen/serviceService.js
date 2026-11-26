const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId } = require('../../utils/vendorValidators');
const { Order, Vendor, Invoice, DiningTable } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const departmentService = require('./departmentService');
const ticketService = require('./ticketService');
const activity = require('./activityService');
const orderNotifications = require('../orderNotifications');

const { ObjectId } = mongoose.Types;
// Orders still on the floor: not completed, not cancelled, not yet with a delivery worker.
const ON_FLOOR = ['placed', 'confirmed', 'preparing', 'ready', 'assigned'];

const destination = (order) => {
  const fulfillment = order.fulfillment || 'delivery';
  if (fulfillment === 'dine_in') return { kind: 'table', label: order.table?.label || 'Table' };
  if (fulfillment === 'pickup') return { kind: 'takeaway', label: `Takeaway · ${order.order_number}` };
  return { kind: 'delivery', label: `Delivery · ${order.delivery_location?.neighborhood || order.delivery_location?.address || order.order_number}` };
};

function serializeForService(order, departments, { invoice = null, canSeeDelivery = false } = {}) {
  const items = order.items || [];
  const live = items.filter((i) => i.service_status !== 'cancelled');
  return {
    id: String(order._id),
    order_number: order.order_number,
    status: order.status,
    status_label: config.orders.statusLabels[order.status],
    fulfillment: order.fulfillment || 'delivery',
    fulfillment_label: config.orders.fulfillmentLabels[order.fulfillment || 'delivery'],
    destination: destination(order),
    guest_name: order.guest?.name || null,
    placed_at: order.created_at,
    payment_status: order.payment_status,
    payment_hold: ticketService.paymentBlocks(order, null, 'collection'),
    priority: order.priority || 'normal',
    assigned_staff: order.assigned_staff?.name ? { id: order.assigned_staff.id, name: order.assigned_staff.name } : null,
    collector: order.collector?.name ? { id: order.collector.id, name: order.collector.name } : null,
    kitchen_courier: order.kitchen_courier ? { staff_id: String(order.kitchen_courier.staff_id), name: order.kitchen_courier.name, status: order.kitchen_courier.status } : null,
    departments: ticketService.ticketProgress(order, departments),
    counts: {
      total: live.length,
      waiting: live.filter((i) => i.service_status === 'waiting_collection').length,
      collected: live.filter((i) => i.service_status === 'collected').length,
      served: live.filter((i) => ['served', 'handed_over'].includes(i.service_status)).length,
      preparing: live.filter((i) => i.service_status === 'pending').length,
    },
    items: items.map((item) => ({
      id: String(item._id),
      name: item.name,
      quantity: item.quantity,
      note: item.note || '',
      department_name: item.department_name || 'Kitchen',
      service_status: item.service_status || 'pending',
      service_status_label: access.SERVICE_STATUS_LABELS[item.service_status || 'pending'],
      collected_by: item.collected_by?.name || null,
      served_by: item.served_by?.name || null,
    })),
    invoice: invoice
      ? { id: String(invoice._id), invoice_number: invoice.invoice_number, status: invoice.status, total_rwf: invoice.total_rwf, balance_due_rwf: invoice.total_rwf - invoice.amount_paid_rwf }
      : null,
    // Delivery handover: where it goes (for coordinators handing it to the delivery worker).
    delivery: canSeeDelivery && ['delivery', 'vendor_delivery'].includes(order.fulfillment)
      ? { address: order.delivery_location?.address || '', neighborhood: order.delivery_location?.neighborhood || '', note: order.delivery_location?.note || '', driver_assigned: Boolean(order.driver_id) }
      : null,
  };
}

class ServiceService {
  /**
   * The server board: every order on the floor, consolidated, with which
   * departments are done and what is waiting at the counter for whom.
   */
  async board(kitchen, query = {}) {
    const filter = { vendor_id: kitchen.vendorId, status: { $in: ON_FLOOR } };
    if (['dine_in', 'pickup', 'delivery'].includes(query.fulfillment)) filter.fulfillment = query.fulfillment;
    if (query.table_id && mongoose.isValidObjectId(query.table_id)) filter['table.table_id'] = new ObjectId(query.table_id);
    if (query.only === 'ready') filter['items.service_status'] = 'waiting_collection';
    // "View assigned orders": given to me, at my tables, collected or delivered by me.
    if (query.mine === 'true' && kitchen.actor.type === 'staff') {
      kitchen.assert('service.view_assigned');
      const me = kitchen.actor.id;
      const myTables = await DiningTable.find({ vendor_id: kitchen.vendorId, assigned_staff_id: new ObjectId(me), deleted_at: null }).select('_id').lean();
      filter.$or = [
        { 'assigned_staff.id': me },
        { 'collector.id': me },
        { 'kitchen_courier.staff_id': new ObjectId(me) },
        ...(myTables.length ? [{ 'table.table_id': { $in: myTables.map((t) => t._id) } }] : []),
      ];
      delete filter.fulfillment;
    } else {
      // Which kinds of orders this person follows: tables, takeaway, delivery.
      const kinds = [];
      if (kitchen.can('service.view_ready') || kitchen.can('service.dine_in')) kinds.push('dine_in');
      if (kitchen.can('service.view_ready') || kitchen.can('service.takeaway')) kinds.push('pickup');
      if (kitchen.can('delivery.view_orders')) kinds.push('delivery', 'vendor_delivery');
      filter.fulfillment = filter.fulfillment ? (kinds.includes(filter.fulfillment) ? filter.fulfillment : '__none__') : { $in: kinds };
    }
    const [orders, departmentList] = await Promise.all([
      Order.find(filter).sort({ created_at: 1 }).limit(200).lean(),
      departmentService.listForVendor(kitchen.vendorId),
    ]);
    const departments = new Map(departmentList.map((d) => [String(d._id), d]));
    const invoiceIds = orders.map((o) => o.invoice_id).filter(Boolean);
    const invoices = kitchen.can('invoices.view') && invoiceIds.length ? await Invoice.find({ _id: { $in: invoiceIds } }).lean() : [];
    const invoiceById = new Map(invoices.map((i) => [String(i._id), i]));
    const rank = { urgent: 0, high: 1, normal: 2 };
    orders.sort((a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2));
    const list = orders.map((order) =>
      serializeForService(order, departments, { invoice: invoiceById.get(String(order.invoice_id)), canSeeDelivery: kitchen.can('delivery.view_locations') })
    );
    return {
      orders: list,
      summary: {
        waiting_items: list.reduce((sum, o) => sum + o.counts.waiting, 0),
        collected_items: list.reduce((sum, o) => sum + o.counts.collected, 0),
        tables: new Set(list.filter((o) => o.fulfillment === 'dine_in').map((o) => o.destination.label)).size,
      },
    };
  }

  async #load(kitchen, orderId) {
    const id = parseObjectId(orderId, 'order_id');
    let order = await Order.findOne({ _id: id, vendor_id: kitchen.vendorId }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    order = await ticketService.ensureTickets(order);
    if (['cancelled', 'delivered'].includes(order.status)) {
      throw ApiError.conflict(`This order is already ${order.status === 'cancelled' ? 'cancelled' : 'completed'}.`, 'ORDER_CLOSED');
    }
    return order;
  }

  #pickItems(order, raw, fromStatuses) {
    const live = order.items.filter((i) => fromStatuses.includes(i.service_status));
    if (raw === undefined || raw === 'all') return live.map((i) => i._id);
    if (!Array.isArray(raw) || raw.some((id) => !mongoose.isValidObjectId(id))) {
      throw ApiError.badRequest('item_ids must be a list of item ids.', { item_ids: 'expected ids' });
    }
    const wanted = new Set(raw.map(String));
    const picked = live.filter((i) => wanted.has(String(i._id)));
    if (picked.length !== wanted.size) {
      throw ApiError.conflict('Some of those items are not at that stage any more. Refresh the board.', 'ITEMS_CHANGED');
    }
    return picked.map((i) => i._id);
  }

  async #assertPartialAllowed(kitchen, order) {
    const vendor = await Vendor.findById(kitchen.vendorId).select('operations').lean();
    const allowPartial = vendor?.operations?.allow_partial_service !== false;
    // Delivery orders always leave together; others as the kitchen chooses.
    const together = order.fulfillment === 'delivery' || order.fulfillment === 'vendor_delivery' || !allowPartial;
    if (together && order.tickets.some((t) => !['ready', 'cancelled'].includes(t.status))) {
      throw ApiError.conflict('Wait until every department has finished this order.', 'ORDER_NOT_COMPLETE');
    }
  }

  /** A server takes ready items from the counter. */
  async collect(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    if (ticketService.paymentBlocks(order, null, 'collection')) {
      throw ApiError.conflict('This bill must be paid before the food leaves the counter (your payment rule). Ask the cashier.', 'PAYMENT_PENDING');
    }
    await this.#assertPartialAllowed(kitchen, order);
    const ids = this.#pickItems(order, body.item_ids, ['waiting_collection']);
    if (!ids.length) throw ApiError.conflict('Nothing is waiting to be collected for this order.', 'NOTHING_TO_COLLECT');
    const now = new Date();
    const result = await Order.updateOne(
      { _id: order._id, status: order.status },
      { $set: { 'items.$[it].service_status': 'collected', 'items.$[it].collected_at': now, 'items.$[it].collected_by': kitchen.actor } },
      { arrayFilters: [{ 'it._id': { $in: ids }, 'it.service_status': 'waiting_collection' }] }
    );
    if (!result.modifiedCount) throw ApiError.conflict('Someone else just collected these items. Refresh the board.', 'ITEMS_CHANGED');
    activity.record(kitchen, { action: 'service.collected', target_type: 'order', target_id: order._id, summary: `Collected ${ids.length} item${ids.length === 1 ? '' : 's'} for ${destination(order).label}` });
    return this.#fresh(kitchen, order._id);
  }

  /**
   * A server put items on the table. When everything of a dine-in order is
   * served, the order is complete (paid or not: the bill is the cashier's).
   */
  async serve(kitchen, orderId, body = {}) {
    const order = await this.#load(kitchen, orderId);
    if (order.fulfillment !== 'dine_in') {
      throw ApiError.conflict(
        order.fulfillment === 'pickup' ? 'Takeaway orders are completed with the customer\'s pickup code.' : 'Delivery orders are completed by the delivery worker.',
        'NOT_A_DINE_IN_ORDER'
      );
    }
    if (ticketService.paymentBlocks(order, null, 'collection')) {
      throw ApiError.conflict('This bill must be paid before serving (your payment rule). Ask the cashier.', 'PAYMENT_PENDING');
    }
    await this.#assertPartialAllowed(kitchen, order);
    const ids = this.#pickItems(order, body.item_ids, ['waiting_collection', 'collected']);
    if (!ids.length) throw ApiError.conflict('Nothing of this order is ready to serve yet.', 'NOTHING_TO_SERVE');
    const now = new Date();
    const result = await Order.updateOne(
      { _id: order._id, status: order.status },
      {
        $set: {
          'items.$[it].service_status': 'served',
          'items.$[it].served_at': now,
          'items.$[it].served_by': kitchen.actor,
        },
      },
      { arrayFilters: [{ 'it._id': { $in: ids }, 'it.service_status': { $in: ['waiting_collection', 'collected'] } }] }
    );
    if (!result.modifiedCount) throw ApiError.conflict('These items were just updated by someone else. Refresh the board.', 'ITEMS_CHANGED');
    // Items taken straight from the counter count as collected by the same person.
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'items.$[it].collected_at': now, 'items.$[it].collected_by': kitchen.actor } },
      { arrayFilters: [{ 'it._id': { $in: ids }, 'it.collected_at': null }] }
    );
    const after = await Order.findById(order._id).lean();
    const everythingServed = after.items.every((i) => ['served', 'cancelled'].includes(i.service_status));
    if (everythingServed) {
      const done = await Order.findOneAndUpdate(
        { _id: order._id, status: { $nin: ['delivered', 'cancelled'] } },
        {
          $set: { status: 'delivered', delivered_at: now, completed_at: now },
          $push: { status_history: { status: 'delivered', at: now, note: `Served at ${order.table?.label || 'the table'}` } },
        },
        { returnDocument: 'after' }
      ).lean();
      if (done) orderNotifications.completed(done);
    }
    activity.record(kitchen, { action: 'service.served', target_type: 'order', target_id: order._id, summary: `Served ${ids.length} item${ids.length === 1 ? '' : 's'} at ${destination(order).label}` });
    return this.#fresh(kitchen, order._id);
  }

  async #fresh(kitchen, orderId) {
    const order = await Order.findById(orderId).lean();
    const departments = new Map((await departmentService.listForVendor(kitchen.vendorId)).map((d) => [String(d._id), d]));
    const invoice = order.invoice_id && kitchen.can('invoices.view') ? await Invoice.findById(order.invoice_id).lean() : null;
    return serializeForService(order, departments, { invoice, canSeeDelivery: kitchen.can('delivery.view_locations') });
  }
}

module.exports = new ServiceService();

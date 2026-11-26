const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { Order, PackingTask, Vendor } = require('../../models');
const alerts = require('./alertService');
const activity = require('./activityService');

/**
 * The packing station. Three different things, kept apart on purpose:
 *   - leftovers: the guest's own food, already on the bill. Packing it never
 *     adds a charge.
 *   - takeaway from a dine-in order: items the guest takes instead of eating
 *     in (same items, same price, nothing new on the bill), or new items
 *     ordered "to take away" (a normal order: priced and billed like any other).
 *   - delivery and pickup orders, when the kitchen packs before dispatch
 *     (`operations.require_packing`): the delivery is only dispatched once
 *     the order is packed.
 */
const OPEN = ['requested', 'packed'];
const anyOf = (kitchen, perms) => {
  if (!perms.some((p) => kitchen.can(p))) kitchen.assert(perms[0]);
};

const view = (t) => ({
  id: String(t._id),
  order_id: String(t.order_id),
  order_number: t.order_number,
  session_id: t.session_id ? String(t.session_id) : null,
  table_label: t.table_label || '',
  kind: t.kind,
  items: (t.items || []).map((i) => ({ item_id: String(i.item_id), name: i.name, quantity: i.quantity, packed: Boolean(i.packed) })),
  instructions: t.instructions || '',
  status: t.status,
  issue: t.issue || '',
  requested_by: t.requested_by?.name || '',
  packed_by: t.packed_by?.name || '',
  handed_over_by: t.handed_over_by?.name || '',
  created_at: t.created_at,
  packed_at: t.packed_at,
  handed_over_at: t.handed_over_at,
  waiting_minutes: Math.round(((t.packed_at ? new Date(t.packed_at) : new Date()) - new Date(t.created_at)) / 60000),
});

class PackingService {
  async #order(kitchen, orderId) {
    const order = await Order.findOne({ _id: parseObjectId(orderId, 'order_id'), vendor_id: kitchen.vendorId }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    return order;
  }

  #pick(order, raw, allowed) {
    const items = order.items.filter((i) => i.service_status !== 'cancelled' && allowed(i));
    if (raw === undefined || raw === 'all') return items;
    if (!Array.isArray(raw) || raw.some((id) => !mongoose.isValidObjectId(id))) throw ApiError.badRequest('item_ids must be a list of item ids.', { item_ids: 'expected ids' });
    const wanted = new Set(raw.map(String));
    const picked = items.filter((i) => wanted.has(String(i._id)));
    if (picked.length !== wanted.size) throw ApiError.conflict('Some of those items cannot be packed. Refresh and try again.', 'ITEMS_CHANGED');
    return picked;
  }

  async #create(order, kind, items, { instructions = '', actor }) {
    const task = await PackingTask.create({
      vendor_id: order.vendor_id,
      order_id: order._id,
      order_number: order.order_number,
      session_id: order.session_id || null,
      table_label: order.table?.label || '',
      kind,
      items: items.map((i) => ({ item_id: i._id, name: i.name, quantity: i.quantity })),
      instructions,
      requested_by: actor,
    });
    const where = order.table?.label || order.order_number;
    alerts.emit(order.vendor_id, 'packing', {
      title: `${{ leftover: 'Pack leftovers', takeaway: 'Pack takeaway', delivery: 'Pack for delivery', pickup: 'Pack for pickup' }[kind]}: ${where}`,
      body: items.map((i) => `${i.quantity}× ${i.name}`).join(', ').slice(0, 200),
      link: '/vendor-dashboard/packing',
      permission: 'packing.view',
    });
    return task.toObject();
  }

  /** The guest's leftovers (already paid for or on the bill): never charged again. */
  async requestLeftovers(kitchen, orderId, body = {}) {
    anyOf(kitchen, ['service.request_packing', 'packing.pack']);
    const order = await this.#order(kitchen, orderId);
    if (order.fulfillment !== 'dine_in') throw ApiError.conflict('Leftovers are packed for dine-in guests.', 'NOT_A_DINE_IN_ORDER');
    const items = this.#pick(order, body.item_ids, (i) => ['served', 'collected', 'waiting_collection'].includes(i.service_status));
    if (!items.length) throw ApiError.conflict('Nothing of this order has been served yet.', 'NOTHING_TO_PACK');
    const open = await PackingTask.exists({ order_id: order._id, kind: 'leftover', status: { $in: OPEN } });
    if (open) throw ApiError.conflict('Leftovers of this order are already waiting to be packed.', 'PACKING_ALREADY_REQUESTED');
    const task = await this.#create(order, 'leftover', items, { instructions: parseOptionalText(body.instructions, { field: 'instructions', max: 200 }) || '', actor: kitchen.actor });
    await activity.record(kitchen, { action: 'packing.leftovers', target_type: 'order', target_id: order._id, summary: `Leftovers to pack for ${order.table?.label || order.order_number} (no charge)` });
    return view(task);
  }

  /**
   * The guest takes some (or all) of a dine-in order away instead. Same
   * items, same bill: nothing is charged twice. Items not served yet go to
   * the packing station when ready instead of to the table.
   */
  async convertToTakeaway(kitchen, orderId, body = {}) {
    anyOf(kitchen, ['orders.change_fulfillment', 'service.request_packing']);
    const order = await this.#order(kitchen, orderId);
    if (order.fulfillment !== 'dine_in') throw ApiError.conflict('Only dine-in orders can be changed to takeaway here.', 'NOT_A_DINE_IN_ORDER');
    if (['delivered', 'cancelled'].includes(order.status)) throw ApiError.conflict('This order is already finished. Pack the leftovers instead.', 'ORDER_CLOSED');
    const items = this.#pick(order, body.item_ids, (i) => !i.takeaway && ['pending', 'waiting_collection', 'collected'].includes(i.service_status));
    if (!items.length) throw ApiError.conflict('Every item is already served or taken away.', 'NOTHING_TO_PACK');
    const ids = items.map((i) => i._id);
    const whole = items.length === order.items.filter((i) => !['cancelled', 'served', 'handed_over'].includes(i.service_status) && !i.takeaway).length;
    const changed = await Order.updateOne(
      { _id: order._id, status: order.status },
      {
        $set: { 'items.$[it].takeaway': true, ...(whole ? { converted_to_takeaway_at: new Date() } : {}) },
        $push: { status_history: { status: order.status, at: new Date(), note: `${items.length} item${items.length === 1 ? '' : 's'} changed to takeaway by ${kitchen.actor.name}` } },
      },
      { arrayFilters: [{ 'it._id': { $in: ids } }] }
    );
    if (!changed.modifiedCount) throw ApiError.conflict('The order just changed. Refresh and try again.', 'ORDER_CHANGED');
    const fresh = await Order.findById(order._id).lean();
    const task = await this.#create(fresh, 'takeaway', fresh.items.filter((i) => ids.some((id) => String(id) === String(i._id))), { instructions: parseOptionalText(body.instructions, { field: 'instructions', max: 200 }) || '', actor: kitchen.actor });
    await activity.record(kitchen, { action: 'order.to_takeaway', target_type: 'order', target_id: order._id, summary: `${order.order_number}: ${items.length} item${items.length === 1 ? '' : 's'} to take away (same bill)` });
    return view(task);
  }

  /** New items ordered "to take away" at the table: they're billed, and packed when ready. */
  async forNewTakeawayItems(order, actor) {
    const items = (order.items || []).filter((i) => i.takeaway);
    if (!items.length) return null;
    return this.#create(order, 'takeaway', items, { actor });
  }

  /** When packing is on, a ready delivery or pickup order waits here before it leaves. */
  async holdsDispatch(order) {
    if (!['delivery', 'vendor_delivery', 'pickup'].includes(order.fulfillment || 'delivery')) return false;
    const vendor = await Vendor.findById(order.vendor_id).select('operations.require_packing').lean();
    if (!vendor?.operations?.require_packing) return false;
    const open = await PackingTask.findOne({ order_id: order._id, kind: { $in: ['delivery', 'pickup'] }, status: { $ne: 'cancelled' } }).lean();
    if (open?.status === 'packed' || open?.status === 'handed_over') return false;
    if (!open) {
      const items = (order.items || []).filter((i) => i.service_status !== 'cancelled');
      await this.#create(order, order.fulfillment === 'pickup' ? 'pickup' : 'delivery', items, { actor: { type: 'system', name: 'Order ready' } });
    }
    // Pickup customers still get their code; only deliveries wait for packing.
    return order.fulfillment !== 'pickup';
  }

  async isPacked(orderId) {
    const task = await PackingTask.findOne({ order_id: orderId, kind: { $in: ['delivery', 'pickup'] }, status: { $ne: 'cancelled' } }).lean();
    return !task || ['packed', 'handed_over'].includes(task.status);
  }

  async list(kitchen, query = {}) {
    kitchen.assert('packing.view');
    const filter = { vendor_id: kitchen.vendorId };
    if (query.status === 'done') {
      filter.status = { $in: ['handed_over', 'cancelled'] };
      filter.updated_at = { $gte: new Date(Date.now() - 86400000) };
    } else filter.status = { $in: OPEN };
    if (['leftover', 'takeaway', 'delivery', 'pickup'].includes(query.kind)) filter.kind = query.kind;
    const rows = await PackingTask.find(filter).sort({ created_at: 1 }).limit(200).lean();
    return { tasks: rows.map(view), counts: { requested: rows.filter((r) => r.status === 'requested').length, packed: rows.filter((r) => r.status === 'packed').length } };
  }

  async #load(kitchen, taskId) {
    const t = await PackingTask.findOne({ _id: parseObjectId(taskId, 'task_id'), vendor_id: kitchen.vendorId }).lean();
    if (!t) throw ApiError.notFound('Packing request not found.', 'PACKING_NOT_FOUND');
    return t;
  }

  /** Packed: the food is ready to go. A delivery order is dispatched now. */
  async pack(kitchen, taskId) {
    kitchen.assert('packing.pack');
    const t = await this.#load(kitchen, taskId);
    const order = await Order.findById(t.order_id).lean();
    if (t.kind === 'takeaway' && order) {
      const notReady = order.items.filter((i) => t.items.some((x) => String(x.item_id) === String(i._id)) && i.service_status === 'pending');
      if (notReady.length) throw ApiError.conflict(`Still being prepared: ${notReady.map((i) => i.name).join(', ')}.`, 'ITEMS_NOT_READY');
    }
    if (['delivery', 'pickup'].includes(t.kind) && order && !['ready', 'assigned'].includes(order.status)) {
      throw ApiError.conflict('The order is not ready yet.', 'ORDER_NOT_READY');
    }
    const now = new Date();
    const saved = await PackingTask.findOneAndUpdate(
      { _id: t._id, status: 'requested' },
      { $set: { status: 'packed', packed_at: now, packed_by: kitchen.actor, 'items.$[].packed': true, issue: '' } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('Someone already packed this.', 'PACKING_CHANGED');
    await Order.updateOne({ _id: t.order_id }, { $set: { packed_at: now }, $push: { status_history: { status: order?.status || 'ready', at: now, note: `Packed by ${kitchen.actor.name}` } } });
    if (t.kind === 'delivery' && order?.fulfillment === 'delivery') {
      try {
        await require('../deliveryService').handleOrderReady(order);
      } catch (error) {
        console.error('[delivery] dispatch after packing failed:', error.message);
      }
    }
    const who = order?.assigned_staff?.id;
    if (who && ['leftover', 'takeaway'].includes(t.kind)) alerts.toStaff(kitchen.vendorId, who, { type: 'packing', title: `Packed for ${t.table_label || t.order_number}`, body: 'Ready to hand to the guests.', link: '/vendor-dashboard/my-tables' });
    if (t.kind === 'delivery') alerts.emit(kitchen.vendorId, 'deliveries', { title: `${t.order_number} is packed`, body: 'Ready for the courier.', link: '/vendor-dashboard/deliveries', permission: 'delivery.view_orders' });
    await activity.record(kitchen, { action: 'packing.packed', target_type: 'order', target_id: t.order_id, summary: `Packed ${t.kind} for ${t.table_label || t.order_number}` });
    return view(saved);
  }

  /** Handed to the guest, the courier or the customer. */
  async handover(kitchen, taskId) {
    anyOf(kitchen, ['packing.handover', 'service.request_packing']);
    const t = await this.#load(kitchen, taskId);
    const now = new Date();
    const saved = await PackingTask.findOneAndUpdate(
      { _id: t._id, status: 'packed' },
      { $set: { status: 'handed_over', handed_over_at: now, handed_over_by: kitchen.actor } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict(t.status === 'requested' ? 'Pack it first.' : 'This was already handed over.', 'PACKING_CHANGED');
    if (t.kind === 'takeaway') {
      const ids = t.items.map((i) => i.item_id);
      await Order.updateOne(
        { _id: t.order_id },
        { $set: { 'items.$[it].service_status': 'handed_over', 'items.$[it].served_at': now, 'items.$[it].served_by': kitchen.actor } },
        { arrayFilters: [{ 'it._id': { $in: ids }, 'it.service_status': { $in: ['waiting_collection', 'collected'] } }] }
      );
      await require('./serviceService').completeIfDone(t.order_id);
    }
    await activity.record(kitchen, { action: 'packing.handed_over', target_type: 'order', target_id: t.order_id, summary: `Handed over ${t.kind} for ${t.table_label || t.order_number}` });
    return view(saved);
  }

  /** Something is wrong (missing item, no containers...), or the request is withdrawn. */
  async reportIssue(kitchen, taskId, body = {}) {
    anyOf(kitchen, ['packing.report_issue', 'packing.pack']);
    const t = await this.#load(kitchen, taskId);
    const issue = parseOptionalText(body.issue, { field: 'issue', max: 200 }) || '';
    const cancel = body.cancel === true;
    if (!issue && !cancel) throw ApiError.badRequest('Say what the problem is.', { issue: 'required' });
    if (cancel && ['delivery', 'pickup'].includes(t.kind)) throw ApiError.conflict('Delivery and pickup orders must be packed before they leave.', 'PACKING_REQUIRED');
    const saved = await PackingTask.findOneAndUpdate(
      { _id: t._id, status: { $in: OPEN } },
      { $set: { issue, ...(cancel ? { status: 'cancelled' } : {}) } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This request is already finished.', 'PACKING_CHANGED');
    if (cancel && t.kind === 'takeaway') {
      // Back to the table: the items are served there as usual.
      await Order.updateOne({ _id: t.order_id }, { $set: { 'items.$[it].takeaway': false } }, { arrayFilters: [{ 'it._id': { $in: t.items.map((i) => i.item_id) } }] });
    }
    if (issue) alerts.emit(kitchen.vendorId, 'packing', { title: `Packing problem: ${t.table_label || t.order_number}`, body: issue, link: '/vendor-dashboard/packing', permission: 'service.view_assigned' });
    await activity.record(kitchen, { action: cancel ? 'packing.cancelled' : 'packing.issue', target_type: 'order', target_id: t.order_id, summary: `${t.table_label || t.order_number}: ${issue || 'packing request withdrawn'}` });
    return view(saved);
  }

  async forOrder(kitchen, orderId) {
    const order = await this.#order(kitchen, orderId);
    return { tasks: (await PackingTask.find({ order_id: order._id, vendor_id: kitchen.vendorId }).sort({ created_at: 1 }).lean()).map(view) };
  }
}

module.exports = new PackingService();

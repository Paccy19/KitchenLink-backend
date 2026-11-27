const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const {
  parseObjectId,
  parseVendorOrderStatus,
  parseSort,
  ORDER_SORTS,
} = require('../utils/vendorValidators');
const { serializeVendorOrder } = require('../utils/serializers');
const orderRepository = require('../repositories/orderRepository');
const customerRepository = require('../repositories/customerRepository');
const deliveryService = require('./deliveryService');
const settlementService = require('./settlementService');
const orderNotifications = require('./orderNotifications');
const notificationService = require('./notificationService');
const dispatchSettingsService = require('./dispatchSettingsService');
const { usesHandoverCode, isKitchenDelivered, balanceUnpaid } = require('../utils/fulfillment');
const { Order } = require('../models');
const ticketService = require('./kitchen/ticketService');
const { ALL } = require('./kitchen/accessService');

const { vendor: vendorConfig } = config;

/** All internal statuses that surface to a vendor under the given status. */
/**
 * Who may move an order to a status: accepting needs orders.accept, turning
 * a new order down orders.reject (or cancel), stopping an accepted one
 * orders.cancel, cooking the kitchen permissions.
 */
function statusNeeds(order, nextStatus) {
  const isNew = vendorConfig.internalToVendorStatus[order.status] === 'new';
  return {
    accepted: ['orders.accept'],
    cancelled: isNew ? ['orders.reject', 'orders.cancel'] : ['orders.cancel'],
    preparing: ['kitchen.start_preparation', 'kitchen.update_progress'],
    ready: ['kitchen.mark_ready'],
  }[nextStatus] || ['orders.accept'];
}

// Order permissions that are about the whole order, not one department's part of it.
const WHOLE_ORDER = ['orders.receive', 'orders.accept', 'orders.reject', 'orders.cancel', 'orders.history', 'orders.handover', 'orders.assign', 'delivery.view_orders', 'delivery.history', 'delivery.track', 'delivery.confirm_completion'];

/**
 * The departments a person sees orders through, or null for the whole order.
 * A baker limited to the Bakery sees only the cake in an order of pilau, cake
 * and coffee; the customer still has one order and one bill.
 */
function departmentView(kitchen) {
  if (!kitchen || kitchen.isAdmin || !kitchen.can('orders.view')) return null;
  const scope = kitchen.scope('orders.view');
  if (scope === ALL || WHOLE_ORDER.some((p) => kitchen.can(p))) return null;
  return new Set(scope.map(String));
}

/** The order as this person sees it: only the next steps their role allows, and whether they can hand it over. */
function forKitchen(serialized, order, kitchen) {
  if (!kitchen || kitchen.isAdmin) return serialized;
  const departments = departmentView(kitchen);
  if (departments) {
    // Their part only: their dishes and tickets, no money, and no order-wide
    // steps (they move their own ticket on the Preparation page).
    const mine = (row) => row.department_id && departments.has(String(row.department_id));
    const out = { ...serialized, items: serialized.items.filter(mine), tickets: serialized.tickets.filter(mine), allowed_next_statuses: [], can_confirm_pickup: false, can_hand_over: false, department_only: true };
    for (const key of Object.keys(out)) if (key.endsWith('_rwf') || key === 'commission_percent') delete out[key];
    delete out.deposit;
    if (out.customer) out.customer = { id: out.customer.id, name: out.customer.name };
    out.items = out.items.map(({ price_rwf, subtotal_rwf, ...item }) => item);
    return out;
  }
  const allowed = (serialized.allowed_next_statuses || []).filter((next) => statusNeeds(order, next).some((p) => kitchen.can(p)));
  const out = { ...serialized, allowed_next_statuses: allowed, can_hand_over: kitchen.can('orders.handover') || kitchen.can('delivery.confirm_completion') };
  // The kitchen's earnings (commission, payout) only for people who handle its money.
  const money = ['finance.revenue', 'overview.sales', 'overview.financial_summary', 'reports.sales', 'reports.financial'].some((p) => kitchen.can(p));
  if (!money) {
    delete out.commission_percent;
    delete out.commission_rwf;
    delete out.vendor_payout_rwf;
    delete out.rider_payout_rwf;
  }
  return out;
}

const internalStatusesFor = (vendorStatus) => {
  if (!vendorStatus) return undefined;
  return Object.entries(vendorConfig.internalToVendorStatus)
    .filter(([, value]) => value === vendorStatus)
    .map(([internal]) => internal);
};

class VendorOrderService {
  async #loadCustomers(orders) {
    const ids = [...new Set(orders.filter((order) => order.customer_id).map((order) => String(order.customer_id)))];
    const customers = await customerRepository.findByIds(ids);
    return new Map(customers.map((customer) => [String(customer._id), customer]));
  }

  /**
   * Which orders a person's role shows: all of them ("View all orders"), or
   * only new ones ("Receive new orders"), finished ones ("View order
   * history") and delivery orders ("View delivery orders" / "history").
   */
  #visibleFilter(kitchen) {
    if (!kitchen || kitchen.isAdmin) return null;
    const departments = departmentView(kitchen);
    if (departments) return { 'items.department_id': { $in: [...departments].map((id) => new mongoose.Types.ObjectId(id)) } };
    if (kitchen.can('orders.view')) return null;
    const finished = ['delivered', 'cancelled'];
    const or = [];
    if (kitchen.can('orders.receive')) or.push({ status: 'placed' });
    if (kitchen.can('orders.history')) or.push({ status: { $in: finished } });
    if (kitchen.can('delivery.view_orders')) or.push({ fulfillment: { $in: ['delivery', 'vendor_delivery'] }, status: { $nin: finished } });
    if (kitchen.can('delivery.history')) or.push({ fulfillment: { $in: ['delivery', 'vendor_delivery'] }, status: { $in: finished } });
    return or.length ? { $or: or } : { _id: null };
  }

  async list(vendor, query = {}, kitchen = null) {
    if (query.status !== undefined && query.status !== '') {
      parseVendorOrderStatus(query.status);
    }
    const sort = parseSort(query.sort, ORDER_SORTS);

    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: vendorConfig.limits.ordersDefault,
      maxLimit: vendorConfig.limits.ordersMax,
    });

    const { orders, total } = await orderRepository.listByVendor(vendor._id, {
      statuses: internalStatusesFor(query.status),
      extra: this.#visibleFilter(kitchen),
      limit,
      offset,
      sort,
    });

    const customers = await this.#loadCustomers(orders);

    return {
      orders: orders.map((order) =>
        forKitchen(serializeVendorOrder(order, { customer: customers.get(String(order.customer_id)) }), order, kitchen)
      ),
      meta: {
        limit,
        page,
        offset,
        total,
        status: query.status || null,
        sort: sort || 'newest',
      },
    };
  }

  async getDetail(vendor, orderId, kitchen = null) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    const departments = departmentView(kitchen);
    if (departments && !(order.items || []).some((item) => item.department_id && departments.has(String(item.department_id)))) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    const customer = order.customer_id ? await customerRepository.findById(order.customer_id) : null;
    return forKitchen(serializeVendorOrder(order, { customer }), order, kitchen);
  }

  async updateStatus(vendor, orderId, body = {}, kitchen = null) {
    const id = parseObjectId(orderId, 'order_id');
    const nextStatus = parseVendorOrderStatus(body?.status);
    if (departmentView(kitchen)) {
      throw ApiError.forbidden('You prepare part of this order: move your own ticket on the Preparation page.', 'KITCHEN_PERMISSION_DENIED');
    }
    // Staff need the permission for this step (the owner has them all).
    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    if (kitchen) {
      const needs = statusNeeds(order, nextStatus);
      if (!needs.some((permission) => kitchen.can(permission))) kitchen.assert(needs[0]);
    }
    const updated = await this.applyStatus(vendor, order, nextStatus, { note: body?.note, actor: kitchen?.actor });
    const customer = order.customer_id ? await customerRepository.findById(order.customer_id) : null;
    return forKitchen(serializeVendorOrder(updated, { customer }), updated, kitchen);
  }

  /**
   * Moves the order to `nextStatus` (kitchen vocabulary) with every side
   * effect: notifications, the pickup code, dispatch to delivery workers, the
   * refund of a cancelled order, and the department tickets catching up.
   * `fromTickets`: the tickets asked for it (they are already there).
   */
  async applyStatus(vendor, order, nextStatus, { note: rawNote, fromTickets = false, actor = null } = {}) {
    const body = { note: rawNote };
    const currentStatus = vendorConfig.internalToVendorStatus[order.status];
    const allowed = vendorConfig.orderTransitions[currentStatus] || [];

    // Kitchens only work on orders the customer has paid for; an unpaid order
    // can only be cancelled (paying the vendor/rider would use other money).
    // (Dine-in bills paid in person follow the kitchen's payment rule instead.)
    const laterBill = order.payment_method === 'in_person' && order.payment_gate !== 'preparation';
    if (nextStatus !== 'cancelled' && order.payment_status !== 'paid' && !laterBill) {
      throw ApiError.conflict(
        "The customer hasn't paid for this order yet. Wait for payment before accepting it.",
        'PAYMENT_PENDING'
      );
    }
    if (!allowed.includes(nextStatus)) {
      throw ApiError.conflict(
        `Cannot move order from "${currentStatus}" to "${nextStatus}".`,
        'INVALID_STATUS_TRANSITION'
      );
    }
    // Big events: the food only goes out once the customer has paid it all.
    if (nextStatus === 'ready' && balanceUnpaid(order)) {
      throw ApiError.conflict(
        "The customer hasn't paid the balance of this event order yet. You can mark it ready once it's paid.",
        'BALANCE_UNPAID'
      );
    }

    const now = new Date();

    // Scheduled/pre-order orders may only be marked ready close to the
    // scheduled slot so drivers are never dispatched far ahead of delivery.
    // (Orders the kitchen delivers itself have no drivers, and it may need to
    // set off hours early, so they skip this.)
    const isFutureScheduled =
      order.order_type !== 'immediate' && order.order_type && order.scheduled_for && !isKitchenDelivered(order);
    if (nextStatus === 'ready' && isFutureScheduled) {
      const readyEarliest = new Date(
        new Date(order.scheduled_for).getTime() -
          config.orders.schedule.readyWindowMinutes * 60 * 1000
      );
      if (now.getTime() < readyEarliest.getTime()) {
        throw ApiError.conflict(
          `This ${order.order_type === 'preorder' ? 'pre-order' : 'scheduled order'} isn't due yet. Mark it ready within ${config.orders.schedule.readyWindowMinutes} minutes of the scheduled delivery time.`,
          'SCHEDULED_ORDER_NOT_DUE'
        );
      }
    }
    if (nextStatus === 'cancelled') {
      await deliveryService.assertCancellable(order._id);
    }
    const note =
      typeof body?.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 200)
        : vendorConfig.orderStatusLabels[nextStatus];
    const update = { status: vendorConfig.vendorToInternalStatus[nextStatus] };

    if (nextStatus === 'cancelled') {
      update.cancelled_at = now;
      update.cancel_reason = note;
    }
    // Pickup and kitchen-delivered orders: the customer has a code to give the kitchen.
    const isPickup = usesHandoverCode(order);
    const kitchenBrings = isKitchenDelivered(order);
    const dineIn = order.fulfillment === 'dine_in';
    if (nextStatus === 'ready' && isPickup) {
      // The code was given at placement; older orders without one get it now.
      const existing = await orderRepository.findPickupCode(order._id);
      update.pickup_code = existing || String(crypto.randomInt(100000, 1000000));
      update.pickup_code_sent_at = now;
      update.pickup_code_attempts = 0;
    }

    // Only from the status it was read in: two departments finishing at the
    // same moment move the order once, not twice.
    const updated = await Order.findOneAndUpdate({ _id: order._id, status: order.status }, { $set: update }, { returnDocument: 'after' }).lean();
    if (!updated) {
      throw ApiError.conflict('This order was just updated by someone else. Refresh and try again.', 'ORDER_CHANGED');
    }
    await orderRepository.pushHistory(order._id, {
      status: update.status,
      at: now,
      note,
    });

    if (nextStatus === 'cancelled') {
      // Return the customer's held payment and withdraw any delivery offer.
      await settlementService.refundOrder(order, { by: 'vendor', reason: note });
      await deliveryService.cancelOpenDelivery(order._id, 'Order cancelled by the kitchen');
      orderNotifications.kitchenCancelled(updated, typeof body?.note === 'string' ? body.note.trim() : '');
    }
    if (nextStatus === 'accepted') orderNotifications.kitchenAccepted(updated);

    // When the kitchen signals the food is ready: a pickup customer gets their
    // code; otherwise the delivery worker (or nearby drivers) are told.
    if (nextStatus === 'ready' && isPickup) {
      await require('./kitchen/packingService').holdsDispatch(order).catch((error) => console.error('[packing]', error.message));
      notificationService
        .notifyPickupCode(order.customer_id, {
          orderNumber: order.order_number,
          code: update.pickup_code,
          orderId: order._id,
          vendorName: vendor.name,
          address: [vendor.address, vendor.neighborhood].filter(Boolean).join(', '),
          kitchenBrings,
        })
        .catch((error) => console.error('[pickup] could not send pickup code:', error.message));
    } else if (nextStatus === 'ready' && dineIn) {
      // Servers see it on their board; nothing is dispatched.
    } else if (nextStatus === 'ready') {
      try {
        // With packing on, the delivery is dispatched once the order is packed.
        const held = await require('./kitchen/packingService').holdsDispatch(order);
        if (!held) await deliveryService.handleOrderReady(order);
      } catch (error) {
        console.error('[delivery] failed to dispatch ready order:', error.message);
      }
    }

    if (!fromTickets) {
      await ticketService.cascadeFromOrder(order._id, nextStatus, actor || { type: 'owner', name: vendor.name });
    }
    return (await orderRepository.findById(order._id)) || updated;
  }

  /**
   * Pickup orders (the customer collected the food) and orders the kitchen
   * delivered itself (nationwide kitchens, far away): the vendor enters the
   * customer's code, which completes the order and credits the vendor.
   * Delivery orders are only ever completed by the delivery worker.
   */
  async confirmPickup(vendor, orderId, body = {}, kitchen = null) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    // The kitchen's own courier confirms the customer's code for their delivery.
    const myDelivery = kitchen && kitchen.actor.type === 'staff' && kitchen.can('delivery.drive') && order.kitchen_courier && String(order.kitchen_courier.staff_id) === kitchen.actor.id;
    if (kitchen && !myDelivery && !kitchen.can('orders.handover') && !kitchen.can('delivery.confirm_completion')) kitchen.assert('orders.handover');
    const kitchenBrings = isKitchenDelivered(order);
    if (!usesHandoverCode(order)) {
      throw ApiError.forbidden(
        'Only orders the customer collects, or that you deliver yourself, can be completed by the kitchen. A delivery worker completes delivery orders.',
        'NOT_A_PICKUP_ORDER'
      );
    }
    if (order.status === 'delivered') {
      throw ApiError.conflict(`This order was already ${kitchenBrings ? 'delivered' : 'collected'}.`, 'ALREADY_COLLECTED');
    }
    if (order.status !== 'ready') {
      throw ApiError.conflict(
        kitchenBrings ? 'Mark the order ready (on the way) before you hand it over.' : 'Mark the order ready before the customer collects it.',
        'ORDER_NOT_READY'
      );
    }
    if (balanceUnpaid(order)) {
      throw ApiError.conflict(
        "The customer hasn't paid the balance of this event order yet. Don't hand the food over until it's paid.",
        'BALANCE_UNPAID'
      );
    }
    const maxAttempts = dispatchSettingsService.current().pickup_code_max_attempts;
    if ((order.pickup_code_attempts || 0) >= maxAttempts) {
      throw ApiError.tooMany(
        'Too many wrong pickup codes for this order. Contact support to complete it.',
        'PICKUP_CODE_LOCKED'
      );
    }
    const code = String(body?.pickup_code ?? '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, 'PICKUP_CODE_INVALID', 'Enter the 6-digit pickup code from the customer.', {
        pickup_code: 'expected 6 digits',
      });
    }

    const now = new Date();
    const collected = await orderRepository.collectPickup(order._id, code, {
      at: now,
      ...(kitchenBrings ? { note: 'Delivered by the kitchen (customer code confirmed)' } : {}),
    });
    if (!collected) {
      const after = await orderRepository.recordPickupAttempt(order._id);
      const left = Math.max(0, maxAttempts - (after?.pickup_code_attempts || 0));
      throw new ApiError(
        400,
        'PICKUP_CODE_INCORRECT',
        left > 0
          ? `Incorrect pickup code. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'Incorrect pickup code. This order is now locked; contact support to complete it.',
        { pickup_code: 'incorrect code', attempts_left: left }
      );
    }

    // Same completion as a delivered order: the vendor is credited.
    const settled = await settlementService.releaseOrder(order._id);
    if (order.kitchen_courier) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'kitchen_courier.status': 'delivered', 'kitchen_courier.updated_at': now }, $push: { 'kitchen_courier.attempts': { at: now, outcome: 'delivered', note: 'Customer code confirmed' } } }
      ).catch(() => null);
    }
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'items.$[it].service_status': 'handed_over' } },
      { arrayFilters: [{ 'it.service_status': { $ne: 'cancelled' } }] }
    ).catch(() => null);
    orderNotifications.completed(settled || collected);

    const customer = await customerRepository.findById(order.customer_id);
    return serializeVendorOrder(settled || collected, { customer });
  }
}

module.exports = new VendorOrderService();

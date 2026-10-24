const crypto = require('crypto');
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

const { vendor: vendorConfig } = config;

/** All internal statuses that surface to a vendor under the given status. */
const internalStatusesFor = (vendorStatus) => {
  if (!vendorStatus) return undefined;
  return Object.entries(vendorConfig.internalToVendorStatus)
    .filter(([, value]) => value === vendorStatus)
    .map(([internal]) => internal);
};

class VendorOrderService {
  async #loadCustomers(orders) {
    const ids = [...new Set(orders.map((order) => String(order.customer_id)))];
    const customers = await customerRepository.findByIds(ids);
    return new Map(customers.map((customer) => [String(customer._id), customer]));
  }

  async list(vendor, query = {}) {
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
      limit,
      offset,
      sort,
    });

    const customers = await this.#loadCustomers(orders);

    return {
      orders: orders.map((order) =>
        serializeVendorOrder(order, {
          customer: customers.get(String(order.customer_id)),
        })
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

  async getDetail(vendor, orderId) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    const customer = await customerRepository.findById(order.customer_id);
    return serializeVendorOrder(order, { customer });
  }

  async updateStatus(vendor, orderId, body = {}) {
    const id = parseObjectId(orderId, 'order_id');
    const nextStatus = parseVendorOrderStatus(body?.status);

    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    const currentStatus = vendorConfig.internalToVendorStatus[order.status];
    const allowed = vendorConfig.orderTransitions[currentStatus] || [];

    // Kitchens only work on orders the customer has paid for; an unpaid order
    // can only be cancelled (paying the vendor/rider would use other money).
    if (nextStatus !== 'cancelled' && order.payment_status !== 'paid') {
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

    const now = new Date();

    // Scheduled/pre-order orders may only be marked ready close to the
    // scheduled slot so drivers are never dispatched far ahead of delivery.
    const isFutureScheduled =
      order.order_type !== 'immediate' && order.order_type && order.scheduled_for;
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
    // Pickup orders: the customer gets a code to show the kitchen.
    const isPickup = order.fulfillment === 'pickup';
    if (nextStatus === 'ready' && isPickup) {
      // The code was given at placement; older orders without one get it now.
      const existing = await orderRepository.findPickupCode(order._id);
      update.pickup_code = existing || String(crypto.randomInt(100000, 1000000));
      update.pickup_code_sent_at = now;
      update.pickup_code_attempts = 0;
    }

    const updated = await orderRepository.update(order._id, update);
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
      notificationService
        .notifyPickupCode(order.customer_id, {
          orderNumber: order.order_number,
          code: update.pickup_code,
          orderId: order._id,
          vendorName: vendor.name,
          address: [vendor.address, vendor.neighborhood].filter(Boolean).join(', '),
        })
        .catch((error) => console.error('[pickup] could not send pickup code:', error.message));
    } else if (nextStatus === 'ready') {
      try {
        await deliveryService.handleOrderReady(order);
      } catch (error) {
        console.error('[delivery] failed to dispatch ready order:', error.message);
      }
    }

    const customer = await customerRepository.findById(order.customer_id);
    return serializeVendorOrder(updated, { customer });
  }

  /**
   * Pickup orders only: the customer collected the food. The vendor enters
   * the customer's pickup code, which completes the order and credits the
   * vendor. Delivery orders are only ever completed by the delivery worker.
   */
  async confirmPickup(vendor, orderId, body = {}) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await orderRepository.findByVendorAndId(vendor._id, id);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    if (order.fulfillment !== 'pickup') {
      throw ApiError.forbidden(
        'Only orders the customer collects themselves can be completed by the kitchen. A delivery worker completes delivery orders.',
        'NOT_A_PICKUP_ORDER'
      );
    }
    if (order.status === 'delivered') {
      throw ApiError.conflict('This order was already collected.', 'ALREADY_COLLECTED');
    }
    if (order.status !== 'ready') {
      throw ApiError.conflict('Mark the order ready before the customer collects it.', 'ORDER_NOT_READY');
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
    const collected = await orderRepository.collectPickup(order._id, code, { at: now });
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
    orderNotifications.completed(settled || collected);

    const customer = await customerRepository.findById(order.customer_id);
    return serializeVendorOrder(settled || collected, { customer });
  }
}

module.exports = new VendorOrderService();

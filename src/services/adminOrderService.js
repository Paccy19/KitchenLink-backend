const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseEnumList,
  parseDateRange,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const { serializeAdminOrder, serializeAdminPayment, serializeDelivery } = require('../utils/serializers');
const orderRepository = require('../repositories/orderRepository');
const paymentRepository = require('../repositories/paymentRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const driverRepository = require('../repositories/driverRepository');
const adminActionLogService = require('./adminActionLogService');
const settlementService = require('./settlementService');
const deliveryService = require('./deliveryService');
const adminOperationsService = require('./adminOperationsService');
const orderNotifications = require('./orderNotifications');
const { usesHandoverCode, isKitchenDelivered } = require('../utils/fulfillment');

class AdminOrderService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const statuses = parseEnumList(query.status, config.orders.statuses, 'status');
    const { from, to } = parseDateRange(query);

    const { orders, total } = await orderRepository.adminList({
      statuses,
      vendorId: query.vendor_id,
      customerId: query.customer_id,
      driverId: query.driver_id,
      fulfillment: parseEnum(query.fulfillment, config.orders.fulfillmentModes, 'fulfillment'),
      from,
      to,
      search: query.search ? String(query.search).trim() : undefined,
      limit,
      offset,
    });
    return { items: orders.map(serializeAdminOrder), total, page, limit };
  }

  async getById(orderId) {
    parseObjectId(orderId, 'order_id');
    const detail = await orderRepository.findDetailedById(orderId);
    if (!detail) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    const [payment, delivery] = await Promise.all([
      paymentRepository.findLatestByOrder(orderId),
      deliveryRepository.findByOrderId(orderId),
    ]);
    const actions = await adminActionLogService.listForTarget('order', orderId);

    return {
      order: serializeAdminOrder(detail),
      payment: payment ? serializeAdminPayment(payment) : null,
      delivery: delivery ? serializeDelivery(delivery, { revealCustomer: true }) : null,
      // Who was offered the order, who accepted or declined, and when.
      dispatch: await adminOperationsService.dispatchSummary(delivery),
      actions,
    };
  }

  async updateStatus(orderId, { status, note }, admin, req) {
    parseObjectId(orderId, 'order_id');
    const nextStatus = parseEnum(status, config.orders.statuses, 'status');
    if (!nextStatus) {
      throw ApiError.badRequest('status is required.', {
        status: `expected one of: ${config.orders.statuses.join(', ')}`,
      });
    }
    const reason = parseOptionalText(note, { field: 'note', max: 500 }) || '';

    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    const now = new Date();
    const update = { status: nextStatus };
    if (nextStatus === 'delivered') {
      update.delivered_at = order.delivered_at || now;
      update.completed_at = order.completed_at || now;
    }
    if (nextStatus === 'cancelled') {
      update.cancelled_at = now;
      update.cancel_reason = reason || 'Cancelled by admin';
    }

    await orderRepository.update(orderId, update);
    await orderRepository.pushHistory(orderId, {
      status: nextStatus,
      at: now,
      note: reason || `Status set to ${nextStatus} by admin`,
    });

    // Admin marking an order delivered/complete releases the held payout.
    if (nextStatus === 'delivered') {
      const settled = await settlementService.releaseOrder(orderId);
      if (order.settlement_status === 'held' && settled) orderNotifications.completed(settled);
    }
    if (nextStatus === 'cancelled') {
      if (order.payment_status === 'paid') await settlementService.refundOrder(order, { by: 'admin', reason });
      await deliveryService.cancelOpenDelivery(orderId, 'Order cancelled by support');
      orderNotifications.adminCancelled(order, reason);
    }

    await adminActionLogService.record(
      admin,
      {
        action: `order.status.${nextStatus}`,
        target_type: 'order',
        target_id: orderId,
        target_label: order.order_number,
        metadata: { from: order.status, to: nextStatus, note: reason },
      },
      req
    );

    const updated = await orderRepository.findDetailedById(orderId);
    return { order: serializeAdminOrder(updated) };
  }

  async cancel(orderId, { reason }, admin, req) {
    return this.updateStatus(orderId, { status: 'cancelled', note: reason }, admin, req);
  }

  /**
   * Support gives the order to a delivery worker they phoned and who agreed
   * to take it (e.g. a nearby worker when the assigned one is late).
   * `contacted: true` confirms that call; `reason: 'late_pickup'` tells the
   * replaced worker, the kitchen and the customer why.
   */
  async reassignDriver(orderId, { driver_id, note, reason, contacted }, admin, req) {
    parseObjectId(orderId, 'order_id');
    parseObjectId(driver_id, 'driver_id');
    const why = parseEnum(reason, ['late_pickup', 'other'], 'reason') || 'other';
    if (contacted !== true) {
      throw ApiError.badRequest('Call the delivery worker first and confirm they agreed to take this order.', {
        contacted: 'confirm you called the delivery worker and they agreed',
      });
    }

    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    if (order.status === 'delivered' || order.status === 'cancelled') {
      throw ApiError.badRequest('Cannot reassign a delivery worker on a closed order.', {
        order_id: 'order is already completed or cancelled',
      });
    }

    if (usesHandoverCode(order)) {
      throw ApiError.conflict(
        isKitchenDelivered(order)
          ? 'The kitchen delivers this order itself, so it has no delivery worker.'
          : 'The customer collects this order at the kitchen, so it has no delivery worker.',
        'NOT_A_DELIVERY_ORDER'
      );
    }

    const driver = await driverRepository.findById(driver_id);
    if (!driver) {
      throw ApiError.notFound('Delivery worker not found.', 'DRIVER_NOT_FOUND');
    }
    if (driver.is_active === false || (driver.verification_status && driver.verification_status !== 'approved')) {
      throw ApiError.conflict(`${driver.name} is not an approved, active delivery worker.`, 'DRIVER_NOT_ELIGIBLE');
    }

    // Moves the delivery itself: status, both workers' load, pickup clock, notifications.
    await deliveryService.adminReassign(order, driver, { reason: why });
    const refreshed = await orderRepository.findById(orderId);
    await orderRepository.pushHistory(orderId, {
      status: refreshed?.status || order.status,
      at: new Date(),
      note:
        note ||
        (why === 'late_pickup'
          ? `Reassigned to ${driver.name} by support (previous delivery worker was late)`
          : `Delivery worker reassigned to ${driver.name} by admin`),
    });

    await adminActionLogService.record(
      admin,
      {
        action: 'order.reassign_driver',
        target_type: 'order',
        target_id: orderId,
        target_label: order.order_number,
        metadata: {
          driver_id: String(driver._id),
          driver_name: driver.name,
          reason: why,
          contacted_by_phone: true,
          note: note || '',
        },
      },
      req
    );

    const updated = await orderRepository.findDetailedById(orderId);
    return { order: serializeAdminOrder(updated) };
  }
}

module.exports = new AdminOrderService();

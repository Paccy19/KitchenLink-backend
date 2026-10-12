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
      await settlementService.releaseOrder(orderId);
    }
    if (nextStatus === 'cancelled' && order.payment_status === 'paid') {
      await settlementService.refundOrder(order);
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

  async reassignDriver(orderId, { driver_id, note }, admin, req) {
    parseObjectId(orderId, 'order_id');
    parseObjectId(driver_id, 'driver_id');

    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    if (order.status === 'delivered' || order.status === 'cancelled') {
      throw ApiError.badRequest('Cannot reassign a driver on a closed order.', {
        order_id: 'order is already completed or cancelled',
      });
    }

    const driver = await driverRepository.findById(driver_id);
    if (!driver) {
      throw ApiError.notFound('Driver not found.', 'DRIVER_NOT_FOUND');
    }

    const now = new Date();
    await orderRepository.update(orderId, {
      driver_id: driver._id,
      rider: { name: driver.name, phone: driver.phone },
    });
    await orderRepository.pushHistory(orderId, {
      status: order.status,
      at: now,
      note: note || `Driver reassigned to ${driver.name} by admin`,
    });

    if (order.delivery_id) {
      await deliveryRepository.update(order.delivery_id, {
        driver_id: driver._id,
        assigned_at: now,
      });
      await deliveryRepository.pushHistory(order.delivery_id, {
        status: 'assigned_to_driver',
        at: now,
        note: `Driver reassigned to ${driver.name} by admin`,
        by: 'admin',
      });
    }

    await adminActionLogService.record(
      admin,
      {
        action: 'order.reassign_driver',
        target_type: 'order',
        target_id: orderId,
        target_label: order.order_number,
        metadata: { driver_id: String(driver._id), driver_name: driver.name },
      },
      req
    );

    const updated = await orderRepository.findDetailedById(orderId);
    return { order: serializeAdminOrder(updated) };
  }
}

module.exports = new AdminOrderService();

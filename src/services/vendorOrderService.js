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
const vendorRepository = require('../repositories/vendorRepository');
const customerRepository = require('../repositories/customerRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const deliveryService = require('./deliveryService');

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
    if (!allowed.includes(nextStatus)) {
      throw ApiError.conflict(
        `Cannot move order from "${currentStatus}" to "${nextStatus}".`,
        'INVALID_STATUS_TRANSITION'
      );
    }

    const now = new Date();
    const note =
      typeof body?.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 200)
        : vendorConfig.orderStatusLabels[nextStatus];
    const update = { status: vendorConfig.vendorToInternalStatus[nextStatus] };

    if (nextStatus === 'cancelled') {
      update.cancelled_at = now;
      update.cancel_reason = note;
    }

    if (nextStatus === 'completed') {
      update.completed_at = now;
    }

    const updated = await orderRepository.update(order._id, update);
    await orderRepository.pushHistory(order._id, {
      status: update.status,
      at: now,
      note,
    });

    if (nextStatus === 'completed') {
      await this.#applyCompletionPayout(vendor, order);
    }

    // When the kitchen signals the food is ready, a delivery is created and
    // broadcast to online drivers automatically (driver gets the notification).
    if (nextStatus === 'ready') {
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
   * Credited exactly once per order: total sales always, and the payable
   * balance net of platform commission.
   */
  async #applyCompletionPayout(vendor, order) {
    const commission = vendorConfig.commissionPercent / 100;
    const balanceRwf = Math.round(order.total_rwf * (1 - commission));

    await Promise.all([
      vendorRepository.incrementSales(vendor._id, {
        totalRwf: order.total_rwf,
        balanceRwf,
      }),
      ...(order.items || []).map((item) =>
        menuItemRepository.incrementOrdersCount(item.menu_item_id, item.quantity)
      ),
    ]);
  }
}

module.exports = new VendorOrderService();

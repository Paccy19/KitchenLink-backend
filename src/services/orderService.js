const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseDeliveryLocation,
  parsePaymentMethod,
  parsePaymentDetails,
} = require('../utils/validators');
const orderRepository = require('../repositories/orderRepository');
const paymentRepository = require('../repositories/paymentRepository');
const cartRepository = require('../repositories/cartRepository');
const cartService = require('./cartService');
const vendorRepository = require('../repositories/vendorRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const notificationRepository = require('../repositories/notificationRepository');
const notificationService = require('./notificationService');

const { orders } = config;

const PROVIDERS = {
  mobile_money: 'momo_mock',
  card: 'card_mock',
  ekash: 'ekash_mock',
  wallet: 'wallet',
};

const methodLabel = (code) =>
  orders.paymentMethods.find((m) => m.code === code)?.label ?? code;

const isCancellable = (status) =>
  ['placed', 'confirmed', 'preparing', 'ready'].includes(status);

const deliveryFee = (subtotalRwf) =>
  subtotalRwf >= orders.freeDeliveryOverRwf ? 0 : orders.deliveryFeeRwf;

const generateOrderNumber = () => {
  const date = new Date();
  const ymd =
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
  return `OFK-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const generateReference = (provider) =>
  `${provider.toUpperCase()}-${Date.now()}-${crypto.randomInt(100000, 999999)}`;

const CLOSED_DELIVERY_STATUSES = ['completed', 'cancelled', 'rejected'];

/**
 * Customer-facing view of the delivery leg. The proof-of-delivery code is only
 * revealed while the delivery is in-flight (and not yet verified) — once it is
 * completed/closed the code is withheld.
 */
const serializeOrderDelivery = (delivery) => {
  if (!delivery) return null;
  const closed =
    CLOSED_DELIVERY_STATUSES.includes(delivery.status) || Boolean(delivery.otp_verified_at);
  return {
    id: String(delivery._id),
    status: delivery.status,
    status_label: config.delivery.statusLabels[delivery.status] || delivery.status,
    otp_required: Boolean(delivery.otp_code),
    proof_of_delivery_code: closed ? null : delivery.otp_code || null,
    otp_verified: Boolean(delivery.otp_verified_at),
    can_confirm: !closed && Boolean(delivery.otp_code),
  };
};

const serializePayment = (payment, orderMethod) => {
  if (!payment) return null;
  return {
    id: String(payment._id),
    method: payment.method,
    method_label: methodLabel(payment.method),
    provider: payment.provider,
    status: payment.status,
    amount_rwf: payment.amount_rwf,
    reference: payment.reference,
    failure_reason: payment.failure_reason || null,
    paid_at: payment.paid_at ?? null,
    ...(orderMethod ? {} : {}),
  };
};

const serializePaymentDetails = (order) => {
  const details = order.payment_details || {};
  const cardNumber = details.card_number || '';
  return {
    phone: details.phone || '',
    card_last4: cardNumber ? cardNumber.slice(-4) : '',
    card_expiry: details.card_expiry || '',
  };
};

const serializeDetail = (order, vendor, payment, delivery) => ({
  id: String(order._id),
  order_number: order.order_number,
  status: order.status,
  status_label: orders.statusLabels[order.status],
  payment_method: order.payment_method,
  payment_method_label: methodLabel(order.payment_method),
  payment_status: order.payment_status,
  payment_details: serializePaymentDetails(order),
  created_at: order.created_at,
  updated_at: order.updated_at,
  vendor: vendor
    ? {
        id: String(vendor._id),
        name: vendor.name,
        vendor_type: vendor.vendor_type,
        banner_image_url: vendor.banner_image_url || null,
        rating: vendor.rating,
      }
    : null,
  items: order.items.map((item) => ({
    menu_item_id: String(item.menu_item_id),
    name: item.name,
    price_rwf: item.price_rwf,
    quantity: item.quantity,
    subtotal_rwf: item.subtotal_rwf,
    image_url: item.image_url || null,
  })),
  subtotal_rwf: order.subtotal_rwf,
  delivery_fee_rwf: order.delivery_fee_rwf,
  total_rwf: order.total_rwf,
  delivery_location: { ...order.delivery_location },
  payment: serializePayment(payment),
  delivery: serializeOrderDelivery(delivery),
  rider: order.rider?.name ? { name: order.rider.name, phone: order.rider.phone } : null,
  status_history: order.status_history.map((entry) => ({
    status: entry.status,
    at: entry.at,
    note: entry.note || '',
  })),
  eta_minutes: order.eta_minutes ?? null,
  estimated_delivery_at: order.estimated_delivery_at ?? null,
  cancelled_at: order.cancelled_at ?? null,
  cancel_reason: order.cancel_reason || null,
});

const serializeTracking = (order, vendor, payment, delivery) => {
  const historyByStatus = new Map(
    (order.status_history || []).map((entry) => [entry.status, entry.at])
  );

  const timeline = orders.timeline.map((status) => ({
    status,
    label: orders.statusLabels[status],
    completed: historyByStatus.has(status),
    at: historyByStatus.get(status) ?? null,
  }));

  if (order.status === 'cancelled') {
    timeline.push({
      status: 'cancelled',
      label: orders.statusLabels.cancelled,
      completed: true,
      at: order.cancelled_at ?? null,
    });
  }

  const [lng, lat] = vendor?.location?.coordinates ?? [null, null];

  return {
    order_id: String(order._id),
    order_number: order.order_number,
    status: order.status,
    status_label: orders.statusLabels[order.status],
    placed_at: order.created_at,
    last_updated_at: order.updated_at,
    payment: payment
      ? {
          method: payment.method,
          method_label: methodLabel(payment.method),
          status: payment.status,
          amount_rwf: payment.amount_rwf,
          reference: payment.reference,
        }
      : null,
    eta_minutes: order.status === 'delivered' ? 0 : order.eta_minutes ?? null,
    estimated_delivery_at: order.estimated_delivery_at ?? null,
    rider: order.rider?.name
      ? { name: order.rider.name, phone: order.rider.phone }
      : null,
    vendor: vendor
      ? {
          id: String(vendor._id),
          name: vendor.name,
          neighborhood: vendor.neighborhood || null,
          location: { latitude: lat, longitude: lng },
        }
      : null,
    delivery_location: { ...order.delivery_location },
    delivery: serializeOrderDelivery(delivery),
    timeline,
    status_history: order.status_history.map((entry) => ({
      status: entry.status,
      at: entry.at,
      note: entry.note || '',
    })),
  };
};

class OrderService {
  paymentMethods() {
    return { payment_methods: orders.paymentMethods };
  }

  async #loadOrder(customerId, orderId) {
    if (!mongoose.isValidObjectId(orderId)) {
      throw ApiError.badRequest('order_id must be a valid id.', {
        order_id: 'expected a valid MongoDB id',
      });
    }
    const order = await orderRepository.findByCustomerAndId(customerId, orderId);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }
    return order;
  }

  async #loadWithVendor(order) {
    const [vendor, payment, delivery] = await Promise.all([
      vendorRepository.findById(order.vendor_id),
      paymentRepository.findLatestByOrder(order._id),
      deliveryRepository.findByOrderId(order._id),
    ]);
    return { order, vendor, payment, delivery };
  }

  async #initiatePayment(order, method, simulate) {
    const provider = PROVIDERS[method];

    let payment = await paymentRepository.create({
      order_id: order._id,
      customer_id: order.customer_id,
      amount_rwf: order.total_rwf,
      method,
      provider,
      status: 'processing',
      reference: generateReference(provider),
    });

    if (simulate === 'fail') {
      payment = await paymentRepository.update(payment._id, {
        status: 'failed',
        failure_reason: 'Payment was declined by the provider.',
      });
      return { paymentStatus: 'failed', payment };
    }

    payment = await paymentRepository.update(payment._id, {
      status: 'successful',
      paid_at: new Date(),
    });
    return { paymentStatus: 'paid', payment };
  }

  async checkout(customerId, body) {
    const deliveryLocation = parseDeliveryLocation(body?.delivery_location);
    const paymentMethod = parsePaymentMethod(body?.payment_method);
    const paymentDetails = parsePaymentDetails(paymentMethod, body?.payment_details);
    const simulate = body?.payment_simulate;

    const entries = (await cartRepository.list(customerId)).filter(
      (entry) => entry.menu_item_id
    );
    if (entries.length === 0) {
      throw ApiError.badRequest('Your cart is empty.', 'CART_EMPTY');
    }

    const unavailable = entries
      .filter((entry) => !entry.menu_item_id.is_available)
      .map((entry) => entry.menu_item_id.name);
    if (unavailable.length > 0) {
      throw ApiError.conflict(
        `These items are no longer available: ${unavailable.join(', ')}.`,
        'CART_ITEM_UNAVAILABLE'
      );
    }

    const vendorIds = [...new Set(entries.map((entry) => String(entry.menu_item_id.vendor_id)))];
    if (vendorIds.length > 1) {
      throw ApiError.conflict(
        'Checkout supports one kitchen at a time. Your cart has items from multiple kitchens.',
        'CART_VENDOR_CONFLICT'
      );
    }

    const vendor = await vendorRepository.findById(vendorIds[0]);
    if (!vendor || !vendor.is_active) {
      throw ApiError.conflict('This kitchen is currently closed.', 'VENDOR_UNAVAILABLE');
    }

    const items = entries.map((entry) => ({
      menu_item_id: entry.menu_item_id._id,
      name: entry.menu_item_id.name,
      price_rwf: entry.menu_item_id.price_rwf,
      quantity: entry.quantity,
      subtotal_rwf: entry.menu_item_id.price_rwf * entry.quantity,
      image_url: entry.menu_item_id.image_url || '',
    }));

    const subtotal = items.reduce((sum, item) => sum + item.subtotal_rwf, 0);
    const fee = deliveryFee(subtotal);
    const total = subtotal + fee;
    const etaMinutes = (vendor.estimated_prep_time ?? 30) + 15;
    const now = new Date();

    const order = await orderRepository.create({
      order_number: generateOrderNumber(),
      customer_id: customerId,
      vendor_id: vendor._id,
      items,
      subtotal_rwf: subtotal,
      delivery_fee_rwf: fee,
      total_rwf: total,
      delivery_location: deliveryLocation,
      payment_method: paymentMethod,
      payment_details: paymentDetails,
      payment_status: 'pending',
      status: 'placed',
      status_history: [{ status: 'placed', at: now, note: 'Order placed' }],
      eta_minutes: etaMinutes,
      estimated_delivery_at: new Date(now.getTime() + etaMinutes * 60 * 1000),
    });

    const { paymentStatus, payment } = await this.#initiatePayment(
      order,
      paymentMethod,
      simulate
    );

    const updatedOrder = await orderRepository.update(order._id, {
      payment_status: paymentStatus,
    });

    await cartRepository.clear(customerId);

    return serializeDetail({ ...order, ...updatedOrder }, vendor, payment);
  }

  async list(customerId, query) {
    if (query.status && !orders.statuses.includes(query.status)) {
      throw ApiError.badRequest('status filter is invalid.', {
        status: `expected one of: ${orders.statuses.join(', ')}`,
      });
    }

    const parsePositiveInt = (value, fallback) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
    };

    const limit = Math.min(
      parsePositiveInt(query.limit, orders ? config.limits.ordersDefault : 10),
      config.limits.ordersMax
    );
    const page = parsePositiveInt(query.page, 1);
    const offset = (page - 1) * limit;

    const { orders: list, total } = await orderRepository.listByCustomer(customerId, {
      status: query.status,
      limit,
      offset,
    });

    const detailed = await Promise.all(
      list.map(async (order) => {
        const { vendor, payment, delivery } = await this.#loadWithVendor(order);
        return serializeDetail(order, vendor, payment, delivery);
      })
    );

    return {
      orders: detailed,
      meta: { limit, page, offset, total, status: query.status || null },
    };
  }

  /**
   * Backfills a delivery-code notification for deliveries that were created
   * before the notification channel existed (or that raced it). Guarantees the
   * customer always has an in-app notification while the delivery is in-flight.
   */
  async #ensureDeliveryCodeNotification(order, delivery) {
    if (!delivery?.otp_code || delivery.otp_verified_at) return;
    if (CLOSED_DELIVERY_STATUSES.includes(delivery.status)) return;

    const existing = await notificationRepository.findByOrderAndCustomer(
      order.customer_id,
      order._id
    );
    if (existing) return;

    try {
      await notificationService.notifyDeliveryCode(order.customer_id, {
        orderNumber: order.order_number,
        orderId: order._id,
        code: delivery.otp_code,
      });
    } catch (error) {
      console.log(`[order] could not backfill delivery code notification: ${error?.message}`);
    }
  }

  async getDetail(customerId, orderId) {
    const order = await this.#loadOrder(customerId, orderId);
    const { vendor, payment, delivery } = await this.#loadWithVendor(order);
    await this.#ensureDeliveryCodeNotification(order, delivery);
    return serializeDetail(order, vendor, payment, delivery);
  }

  async track(customerId, orderId) {
    const order = await this.#loadOrder(customerId, orderId);
    const { vendor, payment, delivery } = await this.#loadWithVendor(order);
    await this.#ensureDeliveryCodeNotification(order, delivery);
    return serializeTracking(order, vendor, payment, delivery);
  }

  async cancel(customerId, orderId, body) {
    const order = await this.#loadOrder(customerId, orderId);

    if (order.status === 'cancelled') {
      throw ApiError.conflict('Order is already cancelled.', 'ALREADY_CANCELLED');
    }
    if (!isCancellable(order.status)) {
      throw ApiError.conflict(
        'This order can no longer be cancelled.',
        'ORDER_NOT_CANCELLABLE'
      );
    }

    const reason =
      typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : '';

    let payment = await paymentRepository.findLatestByOrder(order._id);
    let paymentStatus = order.payment_status;

    if (order.payment_status === 'paid' && payment) {
      payment = await paymentRepository.update(payment._id, {
        status: 'refunded',
      });
      paymentStatus = 'refunded';
    }

    const cancelledAt = new Date();
    const updated = await orderRepository.update(order._id, {
      status: 'cancelled',
      payment_status: paymentStatus,
      cancelled_at: cancelledAt,
      cancel_reason: reason,
    });
    await orderRepository.pushHistory(order._id, {
      status: 'cancelled',
      at: cancelledAt,
      note: reason || 'Cancelled by customer',
    });

    const { vendor } = await this.#loadWithVendor(updated);
    return serializeDetail(updated, vendor, payment);
  }

  async pay(customerId, orderId, body) {
    const order = await this.#loadOrder(customerId, orderId);

    if (order.status === 'cancelled') {
      throw ApiError.conflict('Cancelled orders cannot be paid.', 'ORDER_NOT_PAYABLE');
    }
    if (order.payment_status === 'paid') {
      throw ApiError.conflict('This order is already paid.', 'ALREADY_PAID');
    }

    const method = body?.payment_method
      ? parsePaymentMethod(body.payment_method)
      : order.payment_method;
    const simulate = body?.payment_simulate;

    const { paymentStatus, payment } = await this.#initiatePayment(
      order,
      method,
      simulate
    );

    const updated = await orderRepository.update(order._id, {
      payment_method: method,
      payment_status: paymentStatus,
    });

    const { vendor } = await this.#loadWithVendor(updated);
    return serializeDetail(updated, vendor, payment);
  }

  /**
   * Agent endpoint (vendor / rider): advances order status.
   * Guarded by the x-agent-key header instead of a customer token.
   */
  async updateStatus(orderId, body) {
    if (!mongoose.isValidObjectId(orderId)) {
      throw ApiError.badRequest('order_id must be a valid id.', {
        order_id: 'expected a valid MongoDB id',
      });
    }

    const nextStatus = body?.status;
    if (!orders.statuses.includes(nextStatus)) {
      throw ApiError.badRequest('status is invalid.', {
        status: `expected one of: ${orders.statuses.join(', ')}`,
      });
    }

    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    }

    const from = order.status;
    const terminal = ['cancelled', 'delivered'].includes(from);
    let validTransition = false;

    if (nextStatus === 'cancelled') {
      validTransition = isCancellable(from);
    } else if (!terminal && nextStatus !== 'cancelled') {
      const fromIndex = orders.timeline.indexOf(from);
      const toIndex = orders.timeline.indexOf(nextStatus);
      validTransition = fromIndex !== -1 && toIndex > fromIndex;
    }

    if (!validTransition) {
      throw ApiError.badRequest(
        `Cannot move order from "${from}" to "${nextStatus}".`,
        'INVALID_STATUS_TRANSITION'
      );
    }

    const now = new Date();
    const update = { status: nextStatus };

    if (nextStatus === 'cancelled') {
      update.cancelled_at = now;
      update.cancel_reason =
        typeof body?.note === 'string' && body.note.trim()
          ? body.note.trim().slice(0, 200)
          : 'Cancelled by kitchen';
    }

    let rider = order.rider;
    const bodyRider = body?.rider;
    if (bodyRider && typeof bodyRider.name === 'string') {
      rider = {
        name: bodyRider.name.trim().slice(0, 80),
        phone: typeof bodyRider.phone === 'string' ? bodyRider.phone.trim() : '',
      };
    }
    if (rider?.name) update.rider = rider;

    const payment = await paymentRepository.findLatestByOrder(order._id);

    const updated = await orderRepository.update(order._id, update);
    await orderRepository.pushHistory(order._id, {
      status: nextStatus,
      at: now,
      note:
        typeof body?.note === 'string' && body.note.trim()
          ? body.note.trim().slice(0, 200)
          : orders.statusLabels[nextStatus],
    });

    const refreshed = await orderRepository.findById(order._id);
    const vendor = await vendorRepository.findById(refreshed.vendor_id);
    const delivery = await deliveryRepository.findByOrderId(refreshed._id);
    return serializeDetail(refreshed, vendor, payment, delivery);
  }
}

module.exports = new OrderService();

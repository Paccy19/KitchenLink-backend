const crypto = require('crypto');
const { vendorTypeLabel } = require('../config/vendorTypes');
const vendorOrderingService = require('./vendorOrderingService');
const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseDeliveryLocation,
  parsePaymentMethod,
  parsePaymentDetails,
  parseOrderType,
  parseFulfillment,
  parseScheduledFor,
} = require('../utils/validators');
const orderRepository = require('../repositories/orderRepository');
const paymentRepository = require('../repositories/paymentRepository');
const cartRepository = require('../repositories/cartRepository');
const cartService = require('./cartService');
const vendorRepository = require('../repositories/vendorRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const notificationRepository = require('../repositories/notificationRepository');
const notificationService = require('./notificationService');
const settlementService = require('./settlementService');
const deliveryPricingService = require('./deliveryPricingService');
const deliveryService = require('./deliveryService');
const { isKitchenReady } = require('../utils/deliveryReady');
const orderNotifications = require('./orderNotifications');
const refundService = require('./refundService');
const { serializeRefund } = refundService;
const refundRepository = require('../repositories/refundRepository');
const { isVendorLive } = require('../utils/vendorPresence');
const { usesHandoverCode, isKitchenDelivered } = require('../utils/fulfillment');
const { serializeOrderEvent } = require('../utils/serializers');
const routeDistanceService = require('./routeDistanceService');
const {
  eventPackageFor,
  serializeEventOffer,
  priceEventOrder,
  parseEventOrder,
  depositPlan,
  EVENT_ORDER,
} = require('../config/eventPackages');

const { orders } = config;

const PROVIDERS = {
  mobile_money: 'momo_mock',
  card: 'card_mock',
  ekash: 'ekash_mock',
  wallet: 'wallet',
};

/**
 * Simulated payments mark orders paid without collecting money, so they only
 * run on an explicit development server. On a live server checkout stops
 * here until a real payment provider is connected.
 */
const assertPaymentsAvailable = () => {
  if (config.payments.simulated && !config.explicitDev) {
    throw new ApiError(
      503,
      'PAYMENTS_NOT_CONFIGURED',
      "Online payment isn't available yet. Please try again later."
    );
  }
};

const methodLabel = (code) =>
  orders.paymentMethods.find((m) => m.code === code)?.label ?? code;

const isCancellable = (status) =>
  ['placed', 'confirmed', 'preparing', 'ready'].includes(status);

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

// A pickup order can switch to delivery until it is collected or cancelled.
const SWITCHABLE_STATUSES = ['placed', 'confirmed', 'preparing', 'ready'];

/**
 * Customer-facing view of the delivery leg. The proof-of-delivery code is only
 * revealed while the delivery is in-flight (and not yet verified) — once it is
 * completed/closed the code is withheld.
 */
const serializeOrderDelivery = (delivery) => {
  if (!delivery) return null;
  // The code is shared once the food is ready (the delivery itself may exist
  // earlier: immediate orders are offered to drivers at placement).
  const closed =
    CLOSED_DELIVERY_STATUSES.includes(delivery.status) ||
    Boolean(delivery.otp_verified_at) ||
    !isKitchenReady(delivery);
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

// Once collected or cancelled, the pickup code is no longer shown.
const PICKUP_CODE_HIDDEN = ['delivered', 'completed', 'cancelled'];

/**
 * Pickup orders: where to collect the food and the code to give the kitchen,
 * shown from placement (like a delivery code) until the food is collected.
 * `order.pickup_code` is only present when the caller loaded it for the
 * customer (it is never selected by default).
 */
const serializePickup = (order, vendor) => {
  if (!usesHandoverCode(order)) return null;
  const [lng, lat] = vendor?.location?.coordinates ?? [null, null];
  const awaiting = order.status === 'ready';
  return {
    address: vendor?.address || null,
    neighborhood: vendor?.neighborhood || null,
    latitude: lat,
    longitude: lng,
    vendor_phone: vendor?.phone || null,
    code: PICKUP_CODE_HIDDEN.includes(order.status) ? null : order.pickup_code || null,
    ready_for_collection: awaiting,
    collected_at: order.collected_at ?? null,
    // The kitchen brings it (nationwide kitchen, far away): the customer gives
    // this code to the kitchen at handover instead of collecting.
    kitchen_delivers: isKitchenDelivered(order),
  };
};

const fulfillmentFields = (order, vendor) => ({
  fulfillment: order.fulfillment || 'delivery',
  fulfillment_label: orders.fulfillmentLabels[order.fulfillment || 'delivery'],
  pickup: serializePickup(order, vendor),
});

/** Pickup orders are "collected", not "delivered"; neither they nor kitchen-delivered orders get a rider. */
const customerStatusLabel = (order, status = order.status) =>
  (order.fulfillment === 'pickup' && orders.pickupStatusLabels[status]) ||
  (isKitchenDelivered(order) && orders.vendorDeliveryStatusLabels[status]) ||
  orders.statusLabels[status];

/**
 * Two-part orders (big events): the deposit paid when ordering and the
 * balance due a day before the event. Null for orders paid in one go.
 */
const serializeDeposit = (order) => {
  const deposit = order.deposit;
  if (deposit?.balance_rwf == null) return null;
  const balancePaid = Boolean(deposit.balance_paid_at);
  return {
    deposit_rwf: deposit.deposit_rwf,
    balance_rwf: deposit.balance_rwf,
    balance_due_at: deposit.balance_due_at,
    balance_paid_at: deposit.balance_paid_at ?? null,
    amount_paid_rwf: order.amount_paid_rwf ?? 0,
    amount_due_rwf: balancePaid ? 0 : deposit.balance_rwf,
    // The customer can pay the balance once the deposit is in, until handover.
    can_pay_balance:
      !balancePaid && order.payment_status === 'paid' && !['cancelled', 'delivered'].includes(order.status),
    overdue: !balancePaid && Boolean(deposit.balance_due_at) && new Date(deposit.balance_due_at) < new Date(),
  };
};

const serializeDetail = (order, vendor, payment, delivery, refund = null) => ({
  id: String(order._id),
  order_number: order.order_number,
  ...fulfillmentFields(order, vendor),
  order_type: order.order_type || 'immediate',
  order_type_label:
    orders.orderTypeLabels[order.order_type || 'immediate'] || 'Immediate Order',
  scheduled_for: order.scheduled_for ?? null,
  special_text: order.special_text || '',
  event: serializeOrderEvent(order),
  deposit: serializeDeposit(order),
  status: order.status,
  status_label: customerStatusLabel(order),
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
        vendor_type_label: vendorTypeLabel(vendor.vendor_type),
        banner_image_url: vendor.banner_image_url || null,
        rating: vendor.rating,
        // The customer ordered from this kitchen, so they can always call it.
        phone: vendor.phone || null,
      }
    : null,
  items: order.items.map((item) => ({
    menu_item_id: item.menu_item_id ? String(item.menu_item_id) : null,
    name: item.name,
    price_rwf: item.price_rwf,
    quantity: item.quantity,
    subtotal_rwf: item.subtotal_rwf,
    image_url: item.image_url || null,
  })),
  subtotal_rwf: order.subtotal_rwf,
  delivery_fee_rwf: order.delivery_fee_rwf,
  delivery_distance_km: order.delivery_distance_km ?? null,
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
  // Money going back to the customer for a cancelled paid order.
  refund,
});

const serializeTracking = (order, vendor, payment, delivery) => {
  const historyByStatus = new Map(
    (order.status_history || []).map((entry) => [entry.status, entry.at])
  );

  const steps =
    order.fulfillment === 'pickup'
      ? orders.pickupTimeline
      : isKitchenDelivered(order)
        ? orders.vendorDeliveryTimeline
        : orders.timeline;
  const timeline = steps.map((status) => ({
    status,
    label: customerStatusLabel(order, status),
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
    ...fulfillmentFields(order, vendor),
    order_type: order.order_type || 'immediate',
    order_type_label:
      orders.orderTypeLabels[order.order_type || 'immediate'] || 'Immediate Order',
    scheduled_for: order.scheduled_for ?? null,
    special_text: order.special_text || '',
    status: order.status,
    status_label: customerStatusLabel(order),
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

  /** Offers a newly paid immediate order to nearby delivery workers (background). */
  #offerToDrivers(order) {
    deliveryService.handleOrderPlaced(order).catch((error) =>
      console.error(`[delivery] could not offer ${order?.order_number} to delivery workers:`, error.message)
    );
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

  /**
   * Charges the customer. `part`: 'full' (the whole order), 'deposit' (the
   * first half of a two-part order) or 'balance' (its second half).
   */
  async #initiatePayment(order, method, simulate, { part = 'full' } = {}) {
    assertPaymentsAvailable();
    const provider = PROVIDERS[method];
    const amount =
      part === 'deposit' ? order.deposit.deposit_rwf : part === 'balance' ? order.deposit.balance_rwf : order.total_rwf;

    let payment = await paymentRepository.create({
      order_id: order._id,
      customer_id: order.customer_id,
      amount_rwf: amount,
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

    // Hold the money on the platform account. The first payment also
    // snapshots the commission/payout split for the whole order.
    if (part === 'balance') {
      await settlementService.onBalancePaid(order, amount, { reference: payment.reference });
    } else {
      await settlementService.onPaymentSuccess(order, { amountRwf: part === 'deposit' ? amount : null });
    }

    return { paymentStatus: 'paid', payment, amount };
  }

  async checkout(customerId, body) {
    // Pickup: the customer collects at the kitchen, so no address is needed
    // and no delivery fee is charged. Only their note is kept.
    const fulfillment = parseFulfillment(body?.fulfillment);
    const isPickup = fulfillment === 'pickup';
    const deliveryLocation = isPickup
      ? { note: typeof body?.delivery_location?.note === 'string' ? body.delivery_location.note.trim().slice(0, 300) : '' }
      : parseDeliveryLocation(body?.delivery_location);
    const paymentMethod = parsePaymentMethod(body?.payment_method);
    const paymentDetails = parsePaymentDetails(paymentMethod, body?.payment_details);
    // Before anything is created: no order without a way to really pay.
    assertPaymentsAvailable();
    const simulate = body?.payment_simulate;
    const orderType = parseOrderType(body?.order_type);
    let scheduledFor = null;
    let specialText = '';

    if (orderType === 'scheduled') {
      // The kitchen type sets the real notice / days-ahead window (checked
      // below, once the kitchen is known); this only rejects past or absurd slots.
      scheduledFor = parseScheduledFor(body?.scheduled_for, {
        minLeadMinutes: 0,
        maxDaysAhead: 366,
      });
    }

    const entries = (await cartRepository.list(customerId)).filter(
      (entry) => entry.menu_item_id
    );
    if (entries.length === 0) {
      throw new ApiError(400, 'CART_EMPTY', 'Your cart is empty.');
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
    // Immediate orders need the kitchen open right now; scheduled orders and
    // pre-orders are for later, when the vendor will have opened again.
    if (orderType === 'immediate' && !isVendorLive(vendor)) {
      throw ApiError.conflict(
        'This kitchen is closed right now. Schedule your order for later instead.',
        'VENDOR_CLOSED'
      );
    }

    if (orderType === 'preorder') {
      const special = vendor.special || {};
      if (!special.is_active || !special.text) {
        throw ApiError.conflict(
          'This kitchen has no pre-order special right now.',
          'SPECIAL_NOT_AVAILABLE'
        );
      }
      if (!special.cutoff_at || new Date(special.cutoff_at).getTime() <= Date.now()) {
        throw ApiError.conflict(
          "This kitchen's pre-order special has passed its order-before time.",
          'SPECIAL_CUTOFF_PASSED'
        );
      }
      if (!special.delivery_at) {
        throw ApiError.conflict(
          'This special is missing a delivery time.',
          'SPECIAL_MISSING_DELIVERY_AT'
        );
      }
      scheduledFor = new Date(special.delivery_at);
      specialText = special.text;
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
    // Type rules: advance-only kitchens, notice, minimum order, basket size
    // and daily capacity (config/vendorTypes.js RULES).
    await vendorOrderingService.assertOrderAllowed(vendor, {
      orderType,
      scheduledFor,
      subtotal,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    });
    // Delivery is priced by road distance from the kitchen to the drop-off and
    // charged on top of the food; the rider receives it in full. Pickup is free.
    // Beyond the platform delivery range a nationwide kitchen brings the food
    // itself for its own travel fee ('vendor_delivery'); other kitchens can't.
    const quote = isPickup
      ? { fulfillment: 'pickup', delivery_fee_rwf: 0, distance_km: null, distance_source: null, duration_minutes: 0 }
      : deliveryPricingService.assertDeliverable(await deliveryPricingService.quote(vendor, deliveryLocation));
    const kitchenBrings = quote.fulfillment === 'vendor_delivery';
    if (kitchenBrings && orderType === 'immediate') {
      throw ApiError.conflict(
        `This address is ${Math.round(quote.distance_km)} km from ${vendor.name || 'the kitchen'}, so the kitchen brings the food itself. Schedule the order so they have time to travel.`,
        'SCHEDULE_FAR_ORDER'
      );
    }
    // The kitchen needs time to cook and then travel there.
    if (kitchenBrings && scheduledFor) {
      const needMinutes = (vendor.estimated_prep_time ?? 30) + Math.ceil(quote.duration_minutes ?? quote.distance_km * 2);
      if (scheduledFor.getTime() < Date.now() + needMinutes * 60 * 1000) {
        const hours = Math.ceil(needMinutes / 60);
        throw ApiError.conflict(
          `${vendor.name || 'The kitchen'} needs about ${hours} hour${hours === 1 ? '' : 's'} to prepare and travel ${Math.round(quote.distance_km)} km. Pick a later time.`,
          'FAR_ORDER_TOO_SOON'
        );
      }
    }
    // Pickup and kitchen-delivered orders are completed with the customer's code.
    const usesCode = isPickup || kitchenBrings;
    const fee = quote.delivery_fee_rwf;
    const total = subtotal + fee;
    const etaMinutes = (vendor.estimated_prep_time ?? 30) + (isPickup ? 0 : quote.duration_minutes ?? 15);
    const now = new Date();

    const order = await orderRepository.create({
      order_number: generateOrderNumber(),
      customer_id: customerId,
      vendor_id: vendor._id,
      items,
      subtotal_rwf: subtotal,
      delivery_fee_rwf: fee,
      delivery_distance_km: quote.distance_km,
      delivery_distance_source: quote.distance_source,
      total_rwf: total,
      fulfillment: quote.fulfillment,
      // Pickup orders get their code at once (like a delivery code), so the
      // customer can see it from the start; the kitchen accepts it once ready.
      ...(usesCode
        ? { pickup_code: String(crypto.randomInt(100000, 1000000)), pickup_code_sent_at: now, pickup_code_attempts: 0 }
        : {}),
      delivery_location: deliveryLocation,
      payment_method: paymentMethod,
      payment_details: paymentDetails,
      payment_status: 'pending',
      order_type: orderType,
      scheduled_for: scheduledFor,
      special_text: specialText,
      status: 'placed',
      status_history: [
        {
          status: 'placed',
          at: now,
          note: `Order placed (${orders.orderTypeLabels[orderType] || 'Immediate Order'}${isPickup ? ', customer pickup' : kitchenBrings ? ', delivered by the kitchen' : ''})`,
        },
      ],
      eta_minutes: orderType === 'immediate' ? etaMinutes : null,
      estimated_delivery_at:
        orderType === 'immediate'
          ? new Date(now.getTime() + etaMinutes * 60 * 1000)
          : scheduledFor,
    });

    const { updatedOrder, payment } = await this.#payAndAnnounce(order, {
      customerId,
      vendor,
      paymentMethod,
      simulate,
      usesCode,
      kitchenBrings,
    });

    await cartRepository.clear(customerId);

    return serializeDetail({ ...order, ...updatedOrder }, vendor, payment);
  }

  /**
   * After an order is created: charge it, then tell the kitchen (paid orders
   * only), offer it to delivery workers, send a pickup / handover code, and
   * let the admins know. Shared by the basket checkout and big-event orders.
   */
  async #payAndAnnounce(order, { customerId, vendor, paymentMethod, simulate, usesCode, kitchenBrings }) {
    const total = order.total_rwf;
    // Two-part orders (big events) take the deposit now, the balance later.
    const twoPart = order.deposit?.deposit_rwf != null;
    const { paymentStatus, payment, amount } = await this.#initiatePayment(
      order,
      paymentMethod,
      simulate,
      { part: twoPart ? 'deposit' : 'full' }
    );

    const updatedOrder = await orderRepository.update(order._id, {
      payment_status: paymentStatus,
      ...(twoPart && paymentStatus === 'paid' ? { amount_paid_rwf: amount } : {}),
    });
    // The kitchen only hears about orders that are paid for; nearby delivery
    // workers are offered the order at the same moment.
    if (paymentStatus === 'paid') {
      orderNotifications.newOrder({ ...order, ...updatedOrder });
      this.#offerToDrivers({ ...order, ...updatedOrder });
      if (usesCode && order.pickup_code) {
        notificationService
          .notifyPickupCode(customerId, {
            orderNumber: order.order_number,
            code: order.pickup_code,
            orderId: order._id,
            vendorName: vendor.name,
            address: [vendor.address, vendor.neighborhood].filter(Boolean).join(', '),
            ready: false,
            kitchenBrings,
          })
          .catch((error) => console.error('[pickup] could not send pickup code:', error.message));
      }
    }

    notificationService
      .notifyAdmin({
        type: 'order_placed',
        title: 'New order placed',
        body: `${order.order_number} · ${Number(total).toLocaleString()} RWF at ${vendor.name || 'a vendor'}.`,
        orderId: order._id,
        link: `/admin-dashboard/orders?order=${order._id}`,
        data: {
          order_id: String(order._id),
          order_number: order.order_number,
          vendor_name: vendor.name || null,
          total_rwf: total,
          payment_status: paymentStatus,
          order_type: order.order_type,
          scheduled_for: order.scheduled_for ? new Date(order.scheduled_for).toISOString() : null,
        },
      })
      .catch(() => null);

    if (paymentStatus === 'failed') {
      notificationService
        .notifyAdmin({
          type: 'payment_failed',
          title: 'Payment failed',
          body: `Payment for ${order.order_number} (${Number(total).toLocaleString()} RWF) did not go through.`,
          orderId: order._id,
          link: `/admin-dashboard/payments`,
          data: {
            order_id: String(order._id),
            order_number: order.order_number,
            total_rwf: total,
          },
        })
        .catch(() => null);
    }

    return { updatedOrder, payment };
  }

  /**
   * Big events: the kitchen, its offer and the price for the customer's
   * choices (guests, delivery or pick-up, and where the event is). Delivery
   * is priced by the road distance with the kitchen's own fee ranges.
   */
  async #priceEvent(body = {}, { requireLocation = true } = {}) {
    const { guests, pickup, packageId: chosen } = parseEventOrder(body);
    if (!mongoose.isValidObjectId(body.vendor_id)) {
      throw ApiError.badRequest('vendor_id must be a valid id.', { vendor_id: 'expected a valid id' });
    }
    const vendor = await vendorRepository.findActiveById(body.vendor_id);
    if (!vendor) throw ApiError.notFound('Kitchen not found.', 'VENDOR_NOT_FOUND');
    const offer = eventPackageFor(vendor);
    // The kitchen's packages for these guests (cheapest first), or all of them.
    const packages = (serializeEventOffer(vendor, guests) ?? serializeEventOffer(vendor))?.packages ?? [];
    // No choice yet: the cheapest package for these guests.
    const packageId = chosen || packages[0]?.id || null;

    let deliveryLocation;
    let route = null;
    if (pickup) {
      const note = body.delivery_location?.note;
      deliveryLocation = { note: typeof note === 'string' ? note.trim().slice(0, 300) : '' };
    } else if (!requireLocation && body.delivery_location?.latitude == null) {
      // Quote before the customer has pinned the event: food price only.
      deliveryLocation = null;
    } else {
      // A quote only needs the pin; the order also needs the written address.
      const location = body.delivery_location || {};
      deliveryLocation = parseDeliveryLocation(
        requireLocation ? location : { ...location, address: location.address || 'Event venue' }
      );
      const [lng, lat] = vendor.location?.coordinates ?? [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw ApiError.conflict('This kitchen has no location set, so delivery cannot be priced.', 'VENDOR_LOCATION_MISSING');
      }
      route = await routeDistanceService.measure(
        { latitude: lat, longitude: lng },
        { latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }
      );
    }
    const price = priceEventOrder(offer, guests, { packageId, pickup, distanceKm: route?.distance_km ?? null });
    return { vendor, offer, packages, guests, pickup, deliveryLocation, route, price };
  }

  /**
   * Big events: the kitchen's offer and the exact price before paying (no
   * order is created). Without the event's location a delivery quote has the
   * food price only (`delivery_fee_rwf` null).
   */
  async eventQuote(body = {}) {
    const { vendor, offer, packages, pickup, route, price } = await this.#priceEvent(body, { requireLocation: false });
    const { package: pkg, ...amounts } = price;
    return {
      vendor: {
        id: String(vendor._id),
        name: vendor.name,
        neighborhood: vendor.neighborhood || null,
        address: vendor.address || null,
        avatar_url: vendor.profile_image_url || null,
      },
      // The package priced, the kitchen's other packages to switch to, and
      // the shared delivery fee.
      offer: {
        package: pkg,
        packages: packages.map(({ id, name, description, min_guests, max_guests, from_price_per_plate_rwf }) => ({
          id,
          name,
          description,
          min_guests,
          max_guests,
          from_price_per_plate_rwf,
        })),
        delivery_details: offer.delivery_details,
        delivery_fee_ranges: offer.delivery_fee_ranges,
      },
      quote: {
        ...amounts,
        package_id: pkg.id,
        fulfillment: pickup ? 'pickup' : 'vendor_delivery',
        distance_km: route ? Math.round(route.distance_km * 10) / 10 : null,
        distance_source: route?.source ?? null,
        min_lead_hours: EVENT_ORDER.min_lead_hours,
        // Paid in two parts: this much now, the rest a day before the event.
        deposit_percent: EVENT_ORDER.deposit_percent,
        balance_due_hours_before: EVENT_ORDER.balance_due_hours_before,
        deposit_rwf: depositPlan(price.total_rwf, Date.now()).deposit_rwf,
        balance_rwf: depositPlan(price.total_rwf, Date.now()).balance_rwf,
      },
    };
  }

  /**
   * Big events: the customer orders the kitchen's event plate for their
   * guests, for a date and time at least a day away. The kitchen brings it
   * (and keeps its delivery fee) or the customer picks it up; either way the
   * kitchen finishes the order with the customer's code, like other orders it
   * hands over itself. Payment, the kitchen's orders and payouts work as for
   * any order.
   */
  async eventCheckout(customerId, body = {}) {
    const paymentMethod = parsePaymentMethod(body.payment_method);
    const paymentDetails = parsePaymentDetails(paymentMethod, body.payment_details);
    assertPaymentsAvailable();

    const eventAt = parseScheduledFor(body.event_at, { minLeadMinutes: 0, maxDaysAhead: EVENT_ORDER.max_days_ahead });
    if (eventAt.getTime() < Date.now() + EVENT_ORDER.min_lead_hours * 60 * 60 * 1000) {
      throw ApiError.badRequest(
        `Big events must be booked at least ${EVENT_ORDER.min_lead_hours / 24} days ahead, so the kitchen can prepare and you have time to pay the balance. Pick a later date.`,
        { event_at: `expected at least ${EVENT_ORDER.min_lead_hours} hours from now` }
      );
    }

    const { vendor, offer, guests, pickup, deliveryLocation, route, price } = await this.#priceEvent(body);
    const pkg = price.package;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (note) deliveryLocation.note = [deliveryLocation.note, note].filter(Boolean).join(' | ');

    const fulfillment = pickup ? 'pickup' : 'vendor_delivery';
    const menuSummary = pkg.menu.join(', ');
    // Half now, the rest a day before the event.
    const plan = depositPlan(price.total_rwf, eventAt);
    const now = new Date();
    const order = await orderRepository.create({
      order_number: generateOrderNumber(),
      customer_id: customerId,
      vendor_id: vendor._id,
      items: [
        {
          menu_item_id: null,
          name: `${pkg.name}${menuSummary ? ` (${menuSummary})` : ''}`.slice(0, 200),
          price_rwf: price.price_per_plate_rwf,
          quantity: guests,
          subtotal_rwf: price.food_total_rwf,
        },
      ],
      event: {
        package_id: pkg.id,
        package_name: pkg.name,
        guests,
        price_per_plate_rwf: price.price_per_plate_rwf,
        menu: pkg.menu,
        portion: pkg.portion,
        service_style_label: pkg.service_style_label,
        service_details: pkg.service_details,
        delivery_details: pickup ? '' : offer.delivery_details,
      },
      subtotal_rwf: price.food_total_rwf,
      delivery_fee_rwf: price.delivery_fee_rwf,
      delivery_distance_km: route?.distance_km ?? null,
      delivery_distance_source: route?.source ?? null,
      total_rwf: price.total_rwf,
      deposit: { ...plan, balance_paid_at: null, reminders_sent: [] },
      fulfillment,
      // Completed with the customer's code at handover (collection or
      // delivery). The code is only created once the balance is paid.
      pickup_code_attempts: 0,
      delivery_location: deliveryLocation,
      payment_method: paymentMethod,
      payment_details: paymentDetails,
      payment_status: 'pending',
      order_type: 'scheduled',
      scheduled_for: eventAt,
      status: 'placed',
      status_history: [
        {
          status: 'placed',
          at: now,
          note: `Big event order: ${pkg.name} for ${guests} guests (${pickup ? 'customer pickup' : 'delivered by the kitchen'})`,
        },
      ],
      eta_minutes: null,
      estimated_delivery_at: eventAt,
    });

    const { updatedOrder, payment } = await this.#payAndAnnounce(order, {
      customerId,
      vendor,
      paymentMethod,
      simulate: body.payment_simulate,
      // No code with the deposit: it comes with the balance (payBalance).
      usesCode: false,
      kitchenBrings: !pickup,
    });
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

    const refunds = new Map(
      (await refundRepository.listByOrders(list.map((order) => order._id))).map((refund) => [
        String(refund.order_id),
        serializeRefund(refund),
      ])
    );
    const detailed = await Promise.all(
      list.map(async (order) => {
        const { vendor, payment, delivery } = await this.#loadWithVendor(order);
        return serializeDetail(order, vendor, payment, delivery, refunds.get(String(order._id)) || null);
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
    if (!delivery?.otp_code || delivery.otp_verified_at || !isKitchenReady(delivery)) return;
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
    const order = await this.#withPickupCode(await this.#loadOrder(customerId, orderId));
    const { vendor, payment, delivery } = await this.#loadWithVendor(order);
    await this.#ensureDeliveryCodeNotification(order, delivery);
    return serializeDetail(order, vendor, payment, delivery, await refundService.forOrder(order._id));
  }

  /** The customer's own pickup code, shown from placement until the food is collected. */
  async #withPickupCode(order) {
    if (!usesHandoverCode(order) || PICKUP_CODE_HIDDEN.includes(order.status)) return order;
    return { ...order, pickup_code: await orderRepository.findPickupCode(order._id) };
  }

  /** The customer gives the mobile money number their refund goes to. */
  async changeRefundDestination(customerId, orderId, body) {
    await this.#loadOrder(customerId, orderId);
    return refundService.changeDestination(customerId, orderId, body);
  }

  async listRefunds(customerId) {
    return refundService.listForCustomer(customerId);
  }

  async track(customerId, orderId) {
    const order = await this.#withPickupCode(await this.#loadOrder(customerId, orderId));
    const { vendor, payment, delivery } = await this.#loadWithVendor(order);
    await this.#ensureDeliveryCodeNotification(order, delivery);
    return { ...serializeTracking(order, vendor, payment, delivery), refund: await refundService.forOrder(order._id) };
  }

  /* ------------------------- pickup -> delivery switch ------------------------- */

  /** Checks a pickup order can still become a delivery and returns it with its kitchen. */
  async #switchable(customerId, orderId) {
    const order = await this.#loadOrder(customerId, orderId);
    if (order.fulfillment !== 'pickup') {
      throw ApiError.conflict('This order is already being delivered.', 'ALREADY_DELIVERY');
    }
    if (!SWITCHABLE_STATUSES.includes(order.status)) {
      throw ApiError.conflict(
        order.status === 'cancelled' ? 'This order was cancelled.' : 'This order was already collected.',
        'ORDER_NOT_SWITCHABLE'
      );
    }
    const vendor = await vendorRepository.findById(order.vendor_id);
    if (!vendor) throw ApiError.notFound('Kitchen not found.', 'VENDOR_NOT_FOUND');
    if (vendor.delivery_available === false) {
      throw ApiError.conflict(`${vendor.name} doesn't offer delivery, so this order can only be collected.`, 'DELIVERY_NOT_AVAILABLE');
    }
    return { order, vendor };
  }

  /** Switching to delivery uses platform delivery workers, so the address must be within their range. */
  #platformQuote(quote) {
    if (quote.fulfillment !== 'delivery') {
      throw ApiError.conflict(
        `This address is about ${Math.round(quote.distance_km)} km from the kitchen, beyond the ${quote.platform_max_km} km delivery workers cover. Collect the order, or contact the kitchen.`,
        'OUT_OF_DELIVERY_RANGE'
      );
    }
    return quote;
  }

  /**
   * The delivery fee for switching a pickup order to delivery to this
   * address (shown before the customer pays). Body: { delivery_location }.
   */
  async quoteSwitchToDelivery(customerId, orderId, body = {}) {
    const { order, vendor } = await this.#switchable(customerId, orderId);
    const deliveryLocation = parseDeliveryLocation(body.delivery_location);
    const quote = this.#platformQuote(await deliveryPricingService.quote(vendor, deliveryLocation));
    return {
      order_id: String(order._id),
      delivery_fee_rwf: quote.delivery_fee_rwf,
      distance_km: quote.distance_km,
      duration_minutes: quote.duration_minutes,
      new_total_rwf: Number(order.total_rwf) + quote.delivery_fee_rwf,
      // Paid orders pay just the fee now; unpaid ones pay the new total when they pay.
      pay_now_rwf: order.payment_status === 'paid' ? quote.delivery_fee_rwf : 0,
    };
  }

  /**
   * The customer chose pickup but now wants it delivered: they pay the
   * delivery fee for the new address, the pickup code is retired, and the
   * order is offered to nearby delivery workers (at once if the food is ready
   * or it's an immediate order; otherwise when the kitchen marks it ready).
   * Body: { delivery_location, payment_method, payment_details, payment_simulate }.
   */
  async switchToDelivery(customerId, orderId, body = {}) {
    const { order, vendor } = await this.#switchable(customerId, orderId);
    const deliveryLocation = parseDeliveryLocation(body.delivery_location);
    const quote = this.#platformQuote(await deliveryPricingService.quote(vendor, deliveryLocation));
    const fee = quote.delivery_fee_rwf;
    const now = new Date();
    const alreadyPaid = order.payment_status === 'paid';

    // Paid orders: charge the delivery fee first; nothing changes if it fails.
    let feePayment = null;
    if (alreadyPaid && fee > 0) {
      assertPaymentsAvailable();
      const paymentMethod = parsePaymentMethod(body.payment_method);
      // Same payer checks as checkout (e.g. an MTN/Airtel number for Mobile Money).
      parsePaymentDetails(paymentMethod, body.payment_details);
      const provider = PROVIDERS[paymentMethod];
      feePayment = await paymentRepository.create({
        order_id: order._id,
        customer_id: order.customer_id,
        amount_rwf: fee,
        method: paymentMethod,
        provider,
        status: 'processing',
        reference: generateReference(provider),
      });
      if (body.payment_simulate === 'fail') {
        await paymentRepository.update(feePayment._id, {
          status: 'failed',
          failure_reason: 'Payment was declined by the provider.',
        });
        throw ApiError.badRequest('The delivery fee payment did not go through. Your order is still a pickup order.', {
          payment: 'declined',
        });
      }
      feePayment = await paymentRepository.update(feePayment._id, { status: 'successful', paid_at: now });
    }

    const switched = await orderRepository.switchPickupToDelivery(order._id, SWITCHABLE_STATUSES, {
      set: {
        delivery_location: deliveryLocation,
        delivery_fee_rwf: fee,
        delivery_distance_km: quote.distance_km,
        delivery_distance_source: quote.distance_source,
      },
      inc: { total_rwf: fee },
      historyStatus: order.status,
      note: `Customer switched to delivery${fee ? ` (delivery fee ${fee.toLocaleString('en-US')} RWF${alreadyPaid ? ' paid' : ''})` : ''}`,
      at: now,
    });
    if (!switched) {
      // Collected or cancelled in the meantime: give the fee back.
      if (feePayment) await paymentRepository.update(feePayment._id, { status: 'refunded' });
      throw ApiError.conflict('This order was just collected or cancelled, so it can no longer be delivered.', 'ORDER_NOT_SWITCHABLE');
    }

    let current = switched;
    if (feePayment) {
      current = await settlementService.onDeliveryFeeAdded(switched, fee, { reference: feePayment.reference });
    }

    // Find a delivery worker: now if the food is ready or it's for now; scheduled orders wait for "ready".
    try {
      if (current.status === 'ready') await deliveryService.handleOrderReady(current);
      else if (alreadyPaid) await deliveryService.handleOrderPlaced(current);
    } catch (error) {
      console.error(`[delivery] could not dispatch switched order ${current.order_number}:`, error.message);
    }

    notificationService
      .notifyVendor(current.vendor_id, {
        type: 'order_update',
        title: 'Order changed to delivery',
        body: `${current.order_number}: the customer can't collect it, so a delivery worker will pick it up instead. Their pickup code no longer applies.`,
        orderId: current._id,
        link: `/vendor-dashboard/orders?order=${current._id}`,
      })
      .catch(() => null);

    return this.track(customerId, orderId);
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
    await deliveryService.assertCancellable(order._id);

    const reason =
      typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : '';

    // A paid order's money becomes a refund owed to the customer; the payment
    // shows "refunded" once the money has actually been sent back.
    if (order.payment_status === 'paid') {
      await settlementService.refundOrder(order, { by: 'customer', reason });
    }

    await deliveryService.cancelOpenDelivery(order._id, 'Order cancelled by the customer');
    const cancelledAt = new Date();
    const updated = await orderRepository.update(order._id, {
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancel_reason: reason,
    });
    await orderRepository.pushHistory(order._id, {
      status: 'cancelled',
      at: cancelledAt,
      note: reason || 'Cancelled by customer',
    });
    orderNotifications.customerCancelled(updated, reason);

    const { vendor } = await this.#loadWithVendor(updated);
    const payment = await paymentRepository.findLatestByOrder(order._id);
    const refund = await refundService.forOrder(order._id);
    return serializeDetail(updated, vendor, payment, null, refund);
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

    const twoPart = order.deposit?.deposit_rwf != null;
    const { paymentStatus, payment, amount } = await this.#initiatePayment(
      order,
      method,
      simulate,
      { part: twoPart ? 'deposit' : 'full' }
    );

    const updated = await orderRepository.update(order._id, {
      payment_method: method,
      payment_status: paymentStatus,
      ...(twoPart && paymentStatus === 'paid' ? { amount_paid_rwf: amount } : {}),
    });
    if (paymentStatus === 'paid') {
      orderNotifications.newOrder(updated);
      this.#offerToDrivers(updated);
    }

    const { vendor } = await this.#loadWithVendor(updated);
    return serializeDetail(updated, vendor, payment);
  }

  /**
   * Big events: the customer pays the balance (the second half) of a
   * two-part order, any time before the event and at the latest by
   * `deposit.balance_due_at`. Only then do they get the code to give the
   * kitchen at handover, and the kitchen can hand the food over.
   */
  async payBalance(customerId, orderId, body = {}) {
    const order = await this.#loadOrder(customerId, orderId);
    if (order.deposit?.balance_rwf == null) {
      throw ApiError.conflict('This order was paid in full when it was placed.', 'NO_BALANCE');
    }
    if (order.status === 'cancelled') {
      throw ApiError.conflict('Cancelled orders cannot be paid.', 'ORDER_NOT_PAYABLE');
    }
    if (order.payment_status !== 'paid') {
      throw ApiError.conflict('Pay the deposit first.', 'DEPOSIT_UNPAID');
    }
    if (order.deposit.balance_paid_at) {
      throw ApiError.conflict('The balance is already paid.', 'ALREADY_PAID');
    }

    const method = body.payment_method ? parsePaymentMethod(body.payment_method) : order.payment_method;
    // A new number / card for this payment; otherwise the one used for the deposit.
    const paymentDetails = body.payment_details ? parsePaymentDetails(method, body.payment_details) : null;
    const { paymentStatus, payment, amount } = await this.#initiatePayment(order, method, body.payment_simulate, {
      part: 'balance',
    });
    if (paymentStatus !== 'paid') {
      throw new ApiError(402, 'PAYMENT_FAILED', payment.failure_reason || 'The payment did not go through. Please try again.');
    }

    const now = new Date();
    await orderRepository.pushHistory(order._id, {
      status: order.status,
      at: now,
      note: `Balance of ${amount.toLocaleString('en-US')} RWF paid`,
    });
    // Fully paid: now the customer gets the handover code.
    const code = String(crypto.randomInt(100000, 1000000));
    const updated = await orderRepository.update(order._id, {
      'deposit.balance_paid_at': now,
      amount_paid_rwf: (order.amount_paid_rwf ?? order.deposit.deposit_rwf) + amount,
      pickup_code: code,
      pickup_code_sent_at: now,
      pickup_code_attempts: 0,
      ...(paymentDetails ? { payment_details: paymentDetails } : {}),
    });
    const vendor = await vendorRepository.findById(order.vendor_id);
    notificationService
      .notifyPickupCode(customerId, {
        orderNumber: order.order_number,
        code,
        orderId: order._id,
        vendorName: vendor?.name || '',
        address: [vendor?.address, vendor?.neighborhood].filter(Boolean).join(', '),
        ready: false,
        kitchenBrings: isKitchenDelivered(order),
      })
      .catch((error) => console.error('[pickup] could not send event handover code:', error.message));
    notificationService
      .notifyVendor(order.vendor_id, {
        type: 'order_update',
        title: 'Event order fully paid',
        body: `The customer paid the balance of ${order.order_number}. You can hand the food over with their code.`,
        orderId: order._id,
        link: `/vendor-dashboard/orders?order=${order._id}`,
      })
      .catch(() => null);

    return serializeDetail(await this.#withPickupCode(updated), vendor, payment);
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
    // Completion happens only when the delivery worker confirms the
    // customer's code (driver app), never through this endpoint.
    if (nextStatus === 'delivered') {
      throw ApiError.conflict(
        `Orders are completed when the delivery worker confirms the customer's code.`,
        'COMPLETED_BY_DELIVERY_CODE'
      );
    }
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
      throw new ApiError(
        400,
        'INVALID_STATUS_TRANSITION',
        `Cannot move order from "${from}" to "${nextStatus}".`
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

    // Keep the money in step with the status change.
    if (nextStatus === 'cancelled') {
      await settlementService.refundOrder(order, { by: 'vendor', reason: update.cancel_reason });
      await deliveryService.cancelOpenDelivery(order._id);
    }

    const refreshed = await orderRepository.findById(order._id);
    const vendor = await vendorRepository.findById(refreshed.vendor_id);
    const delivery = await deliveryRepository.findByOrderId(refreshed._id);
    return serializeDetail(refreshed, vendor, payment, delivery);
  }
}

module.exports = new OrderService();

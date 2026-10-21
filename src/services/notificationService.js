const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const { sendSms } = require('../utils/sms');
const { serializeNotification } = require('../utils/serializers');
const { visibleNotificationTypes } = require('../config/adminAccess');
const notificationRepository = require('../repositories/notificationRepository');
const customerRepository = require('../repositories/customerRepository');
const driverRepository = require('../repositories/driverRepository');

const buildDeliveryCodeBody = (orderNumber, code, reminder) => {
  const orderRef = orderNumber ? `order ${orderNumber}` : 'your order';
  return reminder
    ? `Your delivery worker is arriving with ${orderRef}. Share this code to confirm delivery: ${code}`
    : `Keep this code ready for ${orderRef}. Give it to the delivery worker to confirm you received your delivery: ${code}`;
};

const buildDeliveryCodeSms = (orderNumber, code) => {
  const orderRef = orderNumber ? ` for order ${orderNumber}` : '';
  return `FoodKitchen delivery confirmation code${orderRef}: ${code}. Share it with the delivery worker at handover, only once your food arrives.`;
};

class NotificationService {
  /**
   * The delivery "channel": stores an in-app notification the customer reads in
   * their account and mirrors the same message over SMS (when configured).
   *
   * @param {string} customerId
   * @param {{ orderNumber?: string, code: string, orderId?: string, reminder?: boolean }} payload
   */
  /**
   * Pickup orders: the food is ready to collect. Sends the code the customer
   * shows the kitchen, in-app and over SMS.
   */
  async notifyPickupCode(customerId, { orderNumber, code, orderId = null, vendorName = '', address = '' }) {
    if (!customerId || !code) return null;
    const where = [vendorName, address].filter(Boolean).join(', ');
    const body = `${orderNumber || 'Your order'} is ready to collect${where ? ` at ${where}` : ''}. Give the kitchen this pickup code: ${code}.`;
    const notification = await notificationRepository.create({
      customer_id: customerId,
      type: 'pickup_code',
      title: 'Your order is ready for pickup',
      body,
      order_id: orderId || null,
      data: { pickup_code: code, order_number: orderNumber || null, link: orderId ? `/track/${orderId}` : '/track' },
      sms_status: 'pending',
    });

    let smsResult = { status: 'skipped' };
    try {
      const customer = await customerRepository.findById(customerId);
      if (customer?.phone_number) smsResult = await sendSms(customer.phone_number, `FoodKitchen: ${body}`);
      await notificationRepository.setSmsStatus(notification._id, {
        status: smsResult.status,
        error: smsResult.error,
      });
    } catch {
      /* SMS bookkeeping is best-effort */
    }
    return serializeNotification({ ...notification, sms_status: smsResult.status });
  }

  async notifyDeliveryCode(customerId, { orderNumber, code, orderId = null, reminder = false }) {
    if (!customerId || !code) return null;

    const title = reminder ? 'Delivery worker is arriving — delivery code' : 'Delivery confirmation code';
    const body = buildDeliveryCodeBody(orderNumber, code, reminder);
    const data = {
      otp_code: code,
      order_number: orderNumber || null,
      link: orderId ? `/track/${orderId}` : '/track',
    };

    const notification = await notificationRepository.create({
      customer_id: customerId,
      type: 'delivery_code',
      title,
      body,
      order_id: orderId || null,
      data,
      sms_status: 'pending',
    });

    // Mirror the code over SMS. Never let a gateway hiccup break the flow.
    let smsResult = { status: 'skipped' };
    try {
      const customer = await customerRepository.findById(customerId);
      if (customer?.phone_number) {
        smsResult = await sendSms(customer.phone_number, buildDeliveryCodeSms(orderNumber, code));
      }
      await notificationRepository.setSmsStatus(notification._id, {
        status: smsResult.status,
        error: smsResult.error,
      });
    } catch {
      /* SMS bookkeeping is best-effort */
    }

    return serializeNotification({ ...notification, sms_status: smsResult.status });
  }

  async list(customerId, query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: 30,
      maxLimit: 50,
    });

    const [notifications, unreadCount] = await Promise.all([
      notificationRepository.listByCustomer(customerId, { limit, offset }),
      notificationRepository.countUnread(customerId),
    ]);

    return {
      notifications: notifications.map(serializeNotification),
      unread_count: unreadCount,
      meta: { limit, page, offset, unread_count: unreadCount },
    };
  }

  async markRead(customerId, notificationId) {
    const existing = await notificationRepository.findByIdForCustomer(customerId, notificationId);
    if (!existing) {
      throw ApiError.notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');
    }
    const updated = await notificationRepository.markRead(customerId, notificationId);
    return { notification: serializeNotification(updated) };
  }

  async markAllRead(customerId) {
    const updated = await notificationRepository.markAllRead(customerId);
    return { updated, unread_count: 0 };
  }

  /** Order progress for a customer (in-app); opens that order's tracking page. */
  async notifyCustomerOrder(customerId, { orderId, orderNumber, title, body, type = 'order_update', link } = {}) {
    if (!customerId || !title || !body) return null;
    const notification = await notificationRepository.create({
      customer_id: customerId,
      audience: 'customer',
      type,
      title,
      body,
      order_id: orderId || null,
      data: { order_number: orderNumber || null, link: link || (orderId ? `/track/${orderId}` : '/orders') },
      sms_status: 'skipped',
    });
    return serializeNotification(notification);
  }

  /** One in-app notification for each of the given customers (e.g. a kitchen's offer alert). */
  async notifyCustomers(customerIds = [], { type = 'general', title, body, link = '/', data = {} } = {}) {
    if (!customerIds.length || !title || !body) return 0;
    return notificationRepository.createManyForCustomers(customerIds, {
      type,
      title,
      body,
      data: { ...data, link },
      sms_status: 'skipped',
    });
  }

  /* ------------------------------- vendors ------------------------------- */

  /**
   * In-app notification for a vendor. `link` is the vendor-dashboard page it
   * opens (e.g. the order). Best-effort: callers should not await failures.
   */
  async notifyVendor(vendorId, { type = 'general', title, body, orderId = null, link = '/vendor-dashboard', data = {} } = {}) {
    if (!vendorId || !title || !body) return null;
    const notification = await notificationRepository.createForVendor(vendorId, {
      type,
      title,
      body,
      order_id: orderId || null,
      data: { ...data, link },
    });
    return serializeNotification(notification);
  }

  async listForVendor(vendorId, query = {}) {
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 30, maxLimit: 100 });
    const unreadOnly = query.unread === 'true' || query.unread === true;
    const [{ items, total }, unreadCount] = await Promise.all([
      notificationRepository.listByVendor(vendorId, { limit, offset, unreadOnly }),
      notificationRepository.countUnreadByVendor(vendorId),
    ]);
    return {
      notifications: items.map(serializeNotification),
      unread_count: unreadCount,
      meta: { limit, page, offset, total, unread_count: unreadCount },
    };
  }

  async markVendorRead(vendorId, notificationId) {
    const updated = await notificationRepository.markReadByVendor(vendorId, notificationId);
    if (!updated) throw ApiError.notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');
    return { notification: serializeNotification(updated) };
  }

  async markAllVendorRead(vendorId) {
    const updated = await notificationRepository.markAllReadByVendor(vendorId);
    return { updated, unread_count: 0 };
  }

  /* ------------------------------ drivers ------------------------------ */

  /**
   * Alerts an eligible nearby driver about a new order to deliver: offered
   * the moment it is placed (`ready` false, kitchen still cooking) or when the
   * food is ready. Stored in-app (their bell) and mirrored over SMS.
   */
  async notifyDriverOffer(
    driverId,
    {
      vendorName,
      orderNumber,
      pickupNeighborhood,
      earningsRwf = 0,
      orderId = null,
      deliveryId = null,
      expiresAt = null,
      ready = true,
      distanceKm = null,
    }
  ) {
    if (!driverId) return null;

    const vendorRef = vendorName ? ` at ${vendorName}` : '';
    const areaRef = pickupNeighborhood ? ` (${pickupNeighborhood})` : '';
    const awayRef = Number.isFinite(distanceKm) ? `, ${Math.round(distanceKm * 10) / 10} km from you` : '';
    const earn = `Earn ${earningsRwf.toLocaleString?.() ?? earningsRwf} RWF.`;
    const title = ready ? 'New order ready for pickup' : 'New order to deliver';
    const body = ready
      ? `An order${vendorRef} is ready to be picked up${areaRef}${awayRef}. ${earn}`
      : `A new order was just placed${vendorRef}${areaRef}${awayRef}. First to accept delivers it. ${earn}`;
    const data = {
      order_number: orderNumber || null,
      delivery_id: deliveryId ? String(deliveryId) : null,
      earnings_rwf: earningsRwf || 0,
      link: '/driver-dashboard',
      vendor_name: vendorName || null,
      pickup_neighborhood: pickupNeighborhood || null,
      offer_expires_at: expiresAt ? expiresAt.toISOString() : null,
    };

    const notification = await notificationRepository.createForDriver(driverId, {
      type: 'delivery_offer',
      title,
      body,
      order_id: orderId || null,
      data,
      sms_status: 'pending',
    });

    let smsResult = { status: 'skipped' };
    try {
      const driver = await driverRepository.findById(driverId);
      if (driver?.phone) {
        smsResult = await sendSms(
          driver.phone,
          `FoodKitchen: ${body} Open the delivery worker app to accept.`
        );
      }
      await notificationRepository.setSmsStatus(notification._id, {
        status: smsResult.status,
        error: smsResult.error,
      });
    } catch {
      /* SMS bookkeeping is best-effort */
    }

    return serializeNotification({ ...notification, sms_status: smsResult.status });
  }

  /**
   * A delivery update for one driver (assignment, food ready, late pickup,
   * order taken by someone else…). In-app, plus SMS when `sms` is true.
   */
  async notifyDriver(driverId, { type = 'delivery_update', title, body, orderId = null, link = '/driver-dashboard', data = {}, sms = false } = {}) {
    if (!driverId) return null;
    const notification = await notificationRepository.createForDriver(driverId, {
      type,
      title,
      body,
      order_id: orderId || null,
      data: { ...data, link },
      sms_status: sms ? 'pending' : 'skipped',
    });
    if (!sms) return serializeNotification(notification);

    let smsResult = { status: 'skipped' };
    try {
      const driver = await driverRepository.findById(driverId);
      if (driver?.phone) smsResult = await sendSms(driver.phone, `FoodKitchen: ${body}`);
      await notificationRepository.setSmsStatus(notification._id, {
        status: smsResult.status,
        error: smsResult.error,
      });
    } catch {
      /* SMS bookkeeping is best-effort */
    }
    return serializeNotification({ ...notification, sms_status: smsResult.status });
  }

  /** Tell a rider their withdrawal was paid out or failed (in-app + SMS). */
  async notifyDriverPayout(driverId, { status, amountRwf, accountNumber, reference, reason } = {}) {
    if (!driverId) return null;
    const amount = `${Number(amountRwf || 0).toLocaleString()} RWF`;
    const paid = status === 'completed';
    const title = paid ? 'Payout sent' : 'Payout failed';
    const body = paid
      ? `${amount} was sent to ${accountNumber || 'your mobile money'}${reference ? ` (ref ${reference})` : ''}.`
      : `Your ${amount} payout could not be sent${reason ? `: ${reason}` : ''}. The money is back in your balance.`;

    const notification = await notificationRepository.createForDriver(driverId, {
      type: 'payout_update',
      title,
      body,
      data: { status, amount_rwf: amountRwf, reference: reference || null, link: '/driver-dashboard/earnings' },
      sms_status: 'pending',
    });

    let smsResult = { status: 'skipped' };
    try {
      const driver = await driverRepository.findById(driverId);
      if (driver?.phone) smsResult = await sendSms(driver.phone, `FoodKitchen: ${body}`);
      await notificationRepository.setSmsStatus(notification._id, {
        status: smsResult.status,
        error: smsResult.error,
      });
    } catch {
      /* SMS bookkeeping is best-effort */
    }
    return serializeNotification({ ...notification, sms_status: smsResult.status });
  }

  async listForDriver(driverId, query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: 30,
      maxLimit: 50,
    });

    const [notifications, unreadCount] = await Promise.all([
      notificationRepository.listByDriver(driverId, { limit, offset }),
      notificationRepository.countUnreadByDriver(driverId),
    ]);

    return {
      notifications: notifications.map(serializeNotification),
      unread_count: unreadCount,
      meta: { limit, page, offset, unread_count: unreadCount },
    };
  }

  async markDriverRead(driverId, notificationId) {
    const existing = await notificationRepository.findByIdForDriver(driverId, notificationId);
    if (!existing) {
      throw ApiError.notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');
    }
    const updated = await notificationRepository.markReadByDriver(driverId, notificationId);
    return { notification: serializeNotification(updated) };
  }

  async markAllDriverRead(driverId) {
    const updated = await notificationRepository.markAllReadByDriver(driverId);
    return { updated, unread_count: 0 };
  }

  /* -------------------------------- admins -------------------------------- */

  /**
   * Pushes an operations alert onto the shared admin feed. `data.link` is the
   * admin-panel route the alert should open when tapped. Best-effort: callers
   * should tolerate it failing without breaking the originating action.
   */
  async notifyAdmin({ type = 'general', title, body, orderId = null, link = '', data = {} } = {}) {
    if (!title || !body) return null;

    const notification = await notificationRepository.createForAdmin({
      type,
      title,
      body,
      order_id: orderId || null,
      data: { ...data, link: link || null },
      sms_status: 'skipped',
    });

    return serializeNotification(notification);
  }

  /** The alerts this admin's role covers, with their own read state. */
  async listForAdmin(admin, query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: 30,
      maxLimit: 50,
    });
    const scope = { adminId: admin._id, types: visibleNotificationTypes(admin) };

    const [notifications, unreadCount] = await Promise.all([
      notificationRepository.listForAdmin({ ...scope, limit, offset }),
      notificationRepository.countUnreadForAdmin(scope),
    ]);
    const readBy = (notification) =>
      Boolean(notification.read_at) || (notification.read_by || []).some((id) => String(id) === String(admin._id));

    return {
      notifications: notifications.map((notification) => ({
        ...serializeNotification(notification),
        read: readBy(notification),
      })),
      unread_count: unreadCount,
      meta: { limit, page, offset, unread_count: unreadCount },
    };
  }

  async markAdminRead(admin, notificationId) {
    const existing = await notificationRepository.findByIdForAdmin(notificationId, {
      types: visibleNotificationTypes(admin),
    });
    if (!existing) {
      throw ApiError.notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');
    }
    const updated = await notificationRepository.markReadForAdmin(notificationId, admin._id);
    return { notification: { ...serializeNotification(updated), read: true } };
  }

  async markAllAdminRead(admin) {
    const updated = await notificationRepository.markAllReadForAdmin({
      adminId: admin._id,
      types: visibleNotificationTypes(admin),
    });
    return { updated, unread_count: 0 };
  }
}

module.exports = new NotificationService();

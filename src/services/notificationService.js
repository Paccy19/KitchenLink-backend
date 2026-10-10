const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const { sendSms } = require('../utils/sms');
const { serializeNotification } = require('../utils/serializers');
const notificationRepository = require('../repositories/notificationRepository');
const customerRepository = require('../repositories/customerRepository');
const driverRepository = require('../repositories/driverRepository');

const buildDeliveryCodeBody = (orderNumber, code, reminder) => {
  const orderRef = orderNumber ? `order ${orderNumber}` : 'your order';
  return reminder
    ? `Your rider is arriving with ${orderRef}. Share this code to confirm delivery: ${code}`
    : `Keep this code ready for ${orderRef}. Give it to the rider to confirm you received your delivery: ${code}`;
};

const buildDeliveryCodeSms = (orderNumber, code) => {
  const orderRef = orderNumber ? ` for order ${orderNumber}` : '';
  return `FoodKitchen delivery confirmation code${orderRef}: ${code}. Share it with the rider at handover, only once your food arrives.`;
};

class NotificationService {
  /**
   * The delivery "channel": stores an in-app notification the customer reads in
   * their account and mirrors the same message over SMS (when configured).
   *
   * @param {string} customerId
   * @param {{ orderNumber?: string, code: string, orderId?: string, reminder?: boolean }} payload
   */
  async notifyDeliveryCode(customerId, { orderNumber, code, orderId = null, reminder = false }) {
    if (!customerId || !code) return null;

    const title = reminder ? 'Rider is arriving — delivery code' : 'Delivery confirmation code';
    const body = buildDeliveryCodeBody(orderNumber, code, reminder);
    const data = { otp_code: code, order_number: orderNumber || null };

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

  /* ------------------------------ drivers ------------------------------ */

  /**
   * Alerts an eligible nearby driver about an order that is ready for pickup.
   * Stored in-app (their bell) and mirrored over SMS when configured.
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
    }
  ) {
    if (!driverId) return null;

    const vendorRef = vendorName ? ` at ${vendorName}` : '';
    const areaRef = pickupNeighborhood ? ` (${pickupNeighborhood})` : '';
    const title = 'New order ready for pickup';
    const body = `An order${vendorRef} is ready to be picked up${areaRef}. Earn ${earningsRwf.toLocaleString?.() ?? earningsRwf} RWF.`;
    const data = {
      order_number: orderNumber || null,
      delivery_id: deliveryId ? String(deliveryId) : null,
      earnings_rwf: earningsRwf || 0,
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
          `FoodKitchen: ${body} Open the driver app to accept.`
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
}

module.exports = new NotificationService();

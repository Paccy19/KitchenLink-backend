const { Notification } = require('../models');

class NotificationRepository {
  async create(doc) {
    const notification = await Notification.create(doc);
    return notification.toObject();
  }

  async listByCustomer(customerId, { limit = 30, offset = 0 } = {}) {
    return Notification.find({ customer_id: customerId })
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  async countUnread(customerId) {
    return Notification.countDocuments({ customer_id: customerId, read_at: null });
  }

  async findByOrderAndCustomer(customerId, orderId, type = 'delivery_code') {
    return Notification.findOne({ customer_id: customerId, order_id: orderId, type })
      .sort({ created_at: -1 })
      .lean();
  }

  async findByIdForCustomer(customerId, notificationId) {
    return Notification.findOne({ _id: notificationId, customer_id: customerId }).lean();
  }

  async markRead(customerId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, customer_id: customerId },
      { $set: { read_at: new Date() } },
      { new: true }
    ).lean();
  }

  async markAllRead(customerId) {
    const result = await Notification.updateMany(
      { customer_id: customerId, read_at: null },
      { $set: { read_at: new Date() } }
    );
    return result.modifiedCount ?? 0;
  }

  async setSmsStatus(notificationId, { status, error = '' }) {
    await Notification.updateOne(
      { _id: notificationId },
      { $set: { sms_status: status, sms_error: error } }
    );
  }

  async createForDriver(driverId, doc) {
    const notification = await Notification.create({
      driver_id: driverId,
      customer_id: null,
      audience: 'driver',
      ...doc,
    });
    return notification.toObject();
  }

  /* -------------------------------- admins -------------------------------- */

  async createForAdmin(doc) {
    const notification = await Notification.create({
      admin_id: null,
      customer_id: null,
      driver_id: null,
      audience: 'admin',
      ...doc,
    });
    return notification.toObject();
  }

  async listForAdmin({ limit = 30, offset = 0 } = {}) {
    return Notification.find({ audience: 'admin' })
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  async countUnreadForAdmin() {
    return Notification.countDocuments({ audience: 'admin', read_at: null });
  }

  async findByIdForAdmin(notificationId) {
    return Notification.findOne({ _id: notificationId, audience: 'admin' }).lean();
  }

  async markReadForAdmin(notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, audience: 'admin' },
      { $set: { read_at: new Date() } },
      { new: true }
    ).lean();
  }

  async markAllReadForAdmin() {
    const result = await Notification.updateMany(
      { audience: 'admin', read_at: null },
      { $set: { read_at: new Date() } }
    );
    return result.modifiedCount ?? 0;
  }

  async listByDriver(driverId, { limit = 30, offset = 0 } = {}) {
    return Notification.find({ driver_id: driverId })
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  async countUnreadByDriver(driverId) {
    return Notification.countDocuments({ driver_id: driverId, read_at: null });
  }

  async findByIdForDriver(driverId, notificationId) {
    return Notification.findOne({ _id: notificationId, driver_id: driverId }).lean();
  }

  async markReadByDriver(driverId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, driver_id: driverId },
      { $set: { read_at: new Date() } },
      { new: true }
    ).lean();
  }

  async markAllReadByDriver(driverId) {
    const result = await Notification.updateMany(
      { driver_id: driverId, read_at: null },
      { $set: { read_at: new Date() } }
    );
    return result.modifiedCount ?? 0;
  }

  /** A driver may hold several unread order-offer alerts at once. */
  async findOfferForDriver(driverId, orderId, type = 'delivery_offer') {
    return Notification.findOne({ driver_id: driverId, order_id: orderId, type })
      .sort({ created_at: -1 })
      .lean();
  }
}

module.exports = new NotificationRepository();

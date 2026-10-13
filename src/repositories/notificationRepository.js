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

  // The admin feed is shared, but each admin only sees the alert types their
  // role covers (`types`) and has their own read state (`read_by`).
  // `read_at` set by the old shared feed counts as read for everyone.

  async listForAdmin({ adminId, types, limit = 30, offset = 0 } = {}) {
    return Notification.find({ audience: 'admin', type: { $in: types } })
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  async countUnreadForAdmin({ adminId, types }) {
    return Notification.countDocuments({
      audience: 'admin',
      type: { $in: types },
      read_at: null,
      read_by: { $ne: adminId },
    });
  }

  async findByIdForAdmin(notificationId, { types } = {}) {
    return Notification.findOne({
      _id: notificationId,
      audience: 'admin',
      ...(types ? { type: { $in: types } } : {}),
    }).lean();
  }

  async markReadForAdmin(notificationId, adminId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, audience: 'admin' },
      { $addToSet: { read_by: adminId } },
      { new: true }
    ).lean();
  }

  async markAllReadForAdmin({ adminId, types }) {
    const result = await Notification.updateMany(
      { audience: 'admin', type: { $in: types }, read_at: null, read_by: { $ne: adminId } },
      { $addToSet: { read_by: adminId } }
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
  /* -------------------------------- vendors -------------------------------- */

  async createForVendor(vendorId, doc) {
    const notification = await Notification.create({
      vendor_id: vendorId,
      customer_id: null,
      driver_id: null,
      audience: 'vendor',
      sms_status: 'skipped',
      ...doc,
    });
    return notification.toObject();
  }

  async listByVendor(vendorId, { limit = 30, offset = 0, unreadOnly = false } = {}) {
    const filter = { vendor_id: vendorId, audience: 'vendor', ...(unreadOnly ? { read_at: null } : {}) };
    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      Notification.countDocuments(filter),
    ]);
    return { items, total };
  }

  async countUnreadByVendor(vendorId) {
    return Notification.countDocuments({ vendor_id: vendorId, audience: 'vendor', read_at: null });
  }

  async markReadByVendor(vendorId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, vendor_id: vendorId, audience: 'vendor' },
      { $set: { read_at: new Date() } },
      { new: true }
    ).lean();
  }

  async markAllReadByVendor(vendorId) {
    const result = await Notification.updateMany(
      { vendor_id: vendorId, audience: 'vendor', read_at: null },
      { $set: { read_at: new Date() } }
    );
    return result.modifiedCount ?? 0;
  }

  async findOfferForDriver(driverId, orderId, type = 'delivery_offer') {
    return Notification.findOne({ driver_id: driverId, order_id: orderId, type })
      .sort({ created_at: -1 })
      .lean();
  }
}

module.exports = new NotificationRepository();

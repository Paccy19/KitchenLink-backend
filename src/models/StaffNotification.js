const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A notice inside one kitchen: a message an administrator sends to the team,
 * or an automatic alert (new order, ready items, low stock, a guest asking
 * for the waiter …). Addressed to everyone, to people, roles or departments,
 * or to whoever holds a permission. Each person marks it read for themselves.
 */
const staffNotificationSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    kind: { type: String, enum: ['message', 'alert'], default: 'message' },
    // Alerts: which kind (kitchenAccess ALERT_TYPES), so people can mute them.
    alert_type: { type: String, default: null },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '', trim: true },
    link: { type: String, default: '' },
    recipients: {
      all: { type: Boolean, default: false },
      staff_ids: [{ type: String }],
      role_ids: [{ type: String }],
      department_ids: [{ type: String }],
      permission: { type: String, default: null },
      // The kitchen account and administrators.
      admins: { type: Boolean, default: false },
    },
    created_by: {
      type: { type: String, enum: ['owner', 'staff', 'system'], default: 'system' },
      id: { type: String, default: null },
      name: { type: String, default: '' },
    },
    // 'owner' or staff ids.
    read_by: [{ type: String }],
  },
  { timestamps }
);

staffNotificationSchema.index({ vendor_id: 1, created_at: -1 });

module.exports = mongoose.model('StaffNotification', staffNotificationSchema);

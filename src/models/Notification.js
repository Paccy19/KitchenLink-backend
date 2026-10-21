const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A notification. It is the delivery "channel" users read inside the app; the
 * same message can also be dispatched over SMS when a provider is configured
 * (see the `sms_*` bookkeeping fields).
 *
 * Recipients are a customer (`customer_id`), a delivery worker (`driver_id`) or
 * a vendor (`vendor_id`). Every notification carries `data.link`: the page the
 * app opens when it is tapped.
 * `type: 'delivery_code'` notifications carry the proof-of-delivery code in
 * `data.otp_code`. `type: 'delivery_offer'` notifications are the nearby-order
 * alerts pushed to drivers when a delivery is dispatched.
 *
 * Admin notifications form a shared operations feed (`audience: 'admin'`). They
 * carry a `data.link` the admin panel routes to when the admin taps the alert.
 */
const notificationSchema = new mongoose.Schema(
  {
    customer_id: { type: ObjectId, ref: 'Customer', default: null, index: true },
    driver_id: { type: ObjectId, ref: 'Driver', default: null, index: true },
    admin_id: { type: ObjectId, ref: 'Admin', default: null, index: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', default: null, index: true },
    audience: {
      type: String,
      enum: ['customer', 'driver', 'admin', 'vendor'],
      default: 'customer',
      index: true,
    },
    type: {
      type: String,
      enum: [
        'delivery_code',
        'pickup_code',
        'delivery_offer',
        'order_update',
        'general',
        'vendor_application',
        'driver_application',
        'complaint_opened',
        'payout_requested',
        'payout_update',
        'order_placed',
        'payment_failed',
        'owner_finance',
        'account_update',
        'refund_update',
        'support_message',
        'vendor_offer',
        // Delivery worker updates on an order they were offered or took.
        'delivery_update',
        'delivery_taken',
        'delivery_ready',
        'delivery_pickup_reminder',
        'delivery_late',
        'delivery_cancelled',
      ],
      default: 'general',
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    order_id: { type: ObjectId, ref: 'Order', default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    sms_status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    sms_error: { type: String, default: '' },
    read_at: { type: Date, default: null },
    // Admin feed: each team member has their own read state.
    read_by: [{ type: ObjectId, ref: 'Admin' }],
  },
  { timestamps }
);

notificationSchema.index({ customer_id: 1, created_at: -1 });
notificationSchema.index({ customer_id: 1, read_at: 1 });
notificationSchema.index({ driver_id: 1, created_at: -1 });
notificationSchema.index({ driver_id: 1, read_at: 1 });
notificationSchema.index({ vendor_id: 1, created_at: -1 });
notificationSchema.index({ vendor_id: 1, read_at: 1 });
notificationSchema.index({ audience: 1, created_at: -1 });
notificationSchema.index({ audience: 1, read_at: 1 });

module.exports = mongoose.model('Notification', notificationSchema);

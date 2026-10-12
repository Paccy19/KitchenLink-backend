const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A notification. It is the delivery "channel" users read inside the app; the
 * same message can also be dispatched over SMS when a provider is configured
 * (see the `sms_*` bookkeeping fields).
 *
 * Recipients are either a customer (`customer_id`) or a driver (`driver_id`).
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
    audience: {
      type: String,
      enum: ['customer', 'driver', 'admin'],
      default: 'customer',
      index: true,
    },
    type: {
      type: String,
      enum: [
        'delivery_code',
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
  },
  { timestamps }
);

notificationSchema.index({ customer_id: 1, created_at: -1 });
notificationSchema.index({ customer_id: 1, read_at: 1 });
notificationSchema.index({ driver_id: 1, created_at: -1 });
notificationSchema.index({ driver_id: 1, read_at: 1 });
notificationSchema.index({ audience: 1, created_at: -1 });
notificationSchema.index({ audience: 1, read_at: 1 });

module.exports = mongoose.model('Notification', notificationSchema);

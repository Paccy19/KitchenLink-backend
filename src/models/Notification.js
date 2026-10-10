const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A customer-facing notification. It is the delivery "channel" the customer
 * reads inside the app; the same message can also be dispatched over SMS when
 * a provider is configured (see the `sms_*` bookkeeping fields).
 *
 * The proof-of-delivery confirmation code lives in `data.otp_code` for
 * `type: 'delivery_code'` notifications.
 */
const notificationSchema = new mongoose.Schema(
  {
    customer_id: { type: ObjectId, ref: 'Customer', required: true, index: true },
    type: {
      type: String,
      enum: ['delivery_code', 'order_update', 'general'],
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

module.exports = mongoose.model('Notification', notificationSchema);

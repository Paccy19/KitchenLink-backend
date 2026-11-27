const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

const REFUND_STATUSES = ['pending', 'completed', 'failed'];

/**
 * Money owed back to a customer for a paid order that was cancelled.
 *
 *   pending   created when the order is cancelled; the money is still in the
 *             platform account and owed to the customer
 *   completed the money was sent back (reference = MoMo/card transaction id);
 *             only now does the `refund` ledger entry record cash leaving
 *   failed    sending failed (e.g. wrong number); still owed. The customer can
 *             give another number, or an admin retries, which makes it pending
 *
 * Kinds (one refund of each kind per order):
 *   order_cancelled          the paid order was cancelled: what was paid,
 *                            less any refund already given for the order
 *   delivery_fee_adjustment  support lowered an agreed special delivery fee
 *                            when resolving a dispute: the part the customer
 *                            had already paid (the order stays active)
 */
const REFUND_KINDS = ['order_cancelled', 'delivery_fee_adjustment', 'item_unavailable'];

const refundSchema = new mongoose.Schema(
  {
    order_id: { type: ObjectId, ref: 'Order', required: true },
    kind: { type: String, enum: REFUND_KINDS, default: 'order_cancelled' },
    special_delivery_request_id: { type: ObjectId, ref: 'SpecialDeliveryRequest', default: null },
    order_number: { type: String, default: '' },
    customer_id: { type: ObjectId, ref: 'Customer', required: true, index: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', default: null },
    amount_rwf: { type: Number, required: true, min: 0 },
    // How the customer paid; the refund goes back the same way unless the
    // customer gives a mobile money number instead.
    payment_method: { type: String, default: '' },
    destination: {
      type: { type: String, enum: ['mobile_money', 'card'], default: 'mobile_money' },
      phone: { type: String, default: '' },
      card_last4: { type: String, default: '' },
    },
    status: { type: String, enum: REFUND_STATUSES, default: 'pending', index: true },
    cancelled_by: {
      type: String,
      enum: ['customer', 'vendor', 'admin', 'system'],
      default: 'system',
    },
    reason: { type: String, default: '' },
    provider: { type: String, default: 'manual' },
    reference: { type: String, default: '' },
    failure_reason: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    processed_by: { type: ObjectId, ref: 'Admin', default: null },
    completed_at: { type: Date, default: null },
    failed_at: { type: Date, default: null },
  },
  { timestamps }
);

// Replaces the older unique { order_id } index (dropped at start-up by
// scripts/migrateSpecialDelivery.js). Old refunds have no kind: they are
// cancellations, and "missing" never clashes with a delivery adjustment.
refundSchema.index({ order_id: 1, kind: 1 }, { unique: true, name: 'one_refund_per_order_and_kind' });
refundSchema.index({ status: 1, created_at: -1 });
refundSchema.index({ customer_id: 1, created_at: -1 });

module.exports = mongoose.model('Refund', refundSchema);
module.exports.REFUND_STATUSES = REFUND_STATUSES;
module.exports.REFUND_KINDS = REFUND_KINDS;

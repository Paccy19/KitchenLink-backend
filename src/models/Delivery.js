const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A Delivery is the fulfilment leg of an Order. It is created automatically
 * when a vendor marks an order as ready for pickup, then handed to the
 * Driver Web App via dispatch + accept.
 *
 * Status machine (guarded — see config.delivery.transitions):
 *   pending → ready_for_pickup → assigned_to_driver → picked_up
 *           → out_for_delivery → delivered → completed
 *   terminal: cancelled, rejected
 */
const deliverySchema = new mongoose.Schema(
  {
    order_id: { type: ObjectId, ref: 'Order', required: true, unique: true },
    order_number: { type: String, required: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    customer_id: { type: ObjectId, ref: 'Customer', required: true },
    driver_id: { type: ObjectId, ref: 'Driver', default: null },

    pickup_location: {
      address: { type: String, required: true },
      neighborhood: { type: String, default: '' },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
    delivery_location: {
      address: { type: String, required: true },
      neighborhood: { type: String, default: '' },
      note: { type: String, default: '' },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },

    route_distance_km: { type: Number, min: 0, default: 0 },
    delivery_fee_rwf: { type: Number, min: 0, default: 0 },
    promised_earnings_rwf: { type: Number, min: 0, default: 0 },
    payment_method: { type: String, default: '' },

    status: {
      type: String,
      enum: config.delivery.statuses,
      default: 'pending',
    },

    // Proof-of-delivery OTP shared with the customer at dispatch time.
    otp_code: { type: String, default: '' },
    otp_verified_at: { type: Date },
    proof_photo_url: { type: String, default: '' },

    // Dispatch / broadcast bookkeeping.
    dispatch: {
      broadcast_count: { type: Number, default: 0 },
      last_broadcast_at: { type: Date },
      offer_expires_at: { type: Date },
      offers: [
        {
          driver_id: { type: ObjectId, ref: 'Driver' },
          offered_at: { type: Date, default: Date.now },
          expires_at: { type: Date },
          responded_at: { type: Date },
          response: {
            type: String,
            enum: ['offered', 'accepted', 'rejected', 'expired', 'cancelled'],
            default: 'offered',
          },
        },
      ],
    },
    // Drivers who explicitly rejected this delivery (never re-offered).
    rejected_by: [{ type: ObjectId, ref: 'Driver' }],

    status_history: [
      {
        status: { type: String, required: true },
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
        by: { type: String, default: 'system' },
      },
    ],

    // When the kitchen marked the food ready. Deliveries for immediate orders
    // are created and offered at placement ('pending' while the kitchen
    // cooks), so a driver can be assigned before this is set.
    ready_at: { type: Date, default: null },
    // The assigned driver must collect the food by this time:
    // max(ready_at, assigned_at) + pickup grace.
    pickup_due_at: { type: Date, default: null },
    // Late pickup bookkeeping. Charges are decided later; `charge_status`
    // 'pending' marks a late pickup that still has to be charged.
    late_pickup: {
      warned_at: { type: Date, default: null },
      flagged_at: { type: Date, default: null },
      minutes_late: { type: Number, min: 0, default: null },
      charge_status: {
        type: String,
        enum: ['none', 'pending', 'charged', 'waived'],
        default: 'none',
      },
      charge_rwf: { type: Number, min: 0, default: null },
    },

    assigned_at: { type: Date },
    picked_up_at: { type: Date },
    out_for_delivery_at: { type: Date },
    delivered_at: { type: Date },
    completed_at: { type: Date },
    cancelled_at: { type: Date },
    cancel_reason: { type: String, default: '' },
  },
  { timestamps }
);

deliverySchema.index({ status: 1, created_at: -1 });
deliverySchema.index({ status: 1, pickup_due_at: 1 });
deliverySchema.index({ driver_id: 1, status: 1 });
deliverySchema.index({ vendor_id: 1, status: 1 });
deliverySchema.index({ customer_id: 1, created_at: -1 });
deliverySchema.index({ 'pickup_location.neighborhood': 1 });

module.exports = mongoose.model('Delivery', deliverySchema);

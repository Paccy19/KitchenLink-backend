const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const { REQUEST_STATUSES } = require('../config/specialDelivery');

const { ObjectId } = mongoose.Schema.Types;
const point = { latitude: { type: Number, default: null }, longitude: { type: Number, default: null } };

/**
 * A customer's request for a special big-event delivery arrangement, opened
 * when automatic pricing can't be used (destination outside the kitchen's
 * coverage, or the automatic fee above the platform ceiling). The kitchen
 * reviews it, both sides talk in a dedicated chat, and the kitchen submits
 * formal quotations (DeliveryQuotation). Only a quotation the customer
 * accepted sets the delivery fee of the big-event order.
 *
 * Status changes only go through services/specialDeliveryTransitions.js and
 * are all kept in status_history (never deleted, also after a cancelled order
 * or a failed payment).
 */
const specialDeliveryRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true }, // SD-000124
    customer_id: { type: ObjectId, ref: 'Customer', required: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    // Set when the customer books the event order with the agreed price.
    order_id: { type: ObjectId, ref: 'Order', default: null },
    // What the customer is booking (so the kitchen knows the size).
    event: {
      package_id: { type: String, default: '' },
      package_name: { type: String, default: '' },
      guests: { type: Number, min: 1, default: null },
      event_at: { type: Date, default: null },
      description: { type: String, default: '', trim: true },
    },
    delivery_location: {
      address: { type: String, required: true, trim: true },
      neighborhood: { type: String, default: '' },
      note: { type: String, default: '' },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
    destination_district: { type: String, default: null },
    pickup: point, // the kitchen's verified location when the request was made
    route: {
      distance_m: { type: Number, min: 0, default: null },
      distance_source: { type: String, default: null },
      duration_minutes: { type: Number, min: 0, default: null },
    },
    // Why automatic pricing could not be used: 'outside_coverage', 'above_ceiling'.
    trigger_reasons: [{ type: String, enum: ['outside_coverage', 'above_ceiling', 'route_unavailable', 'automatic_pricing_off'] }],
    // The platform's calculated fee (information only, never charged).
    calculated_fee_rwf: { type: Number, min: 0, default: null },
    auto_ceiling_rwf: { type: Number, min: 0, default: null },
    requested_delivery_at: { type: Date, required: true },
    instructions: { type: String, default: '', trim: true },

    status: { type: String, enum: REQUEST_STATUSES, default: 'pending_vendor_review' },
    // True while the request is open (not declined, cancelled or completed).
    is_active: { type: Boolean, default: true },
    // One open request per customer–kitchen pair (before an order exists) or per order.
    dedupe_key: { type: String, required: true },
    status_history: [
      {
        _id: false,
        from: { type: String, default: null },
        to: { type: String, required: true },
        actor_role: { type: String, enum: ['customer', 'vendor', 'admin', 'system'], required: true },
        actor_id: { type: ObjectId, default: null },
        reason: { type: String, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],
    info_request: { type: String, default: '' },
    decline_reason: { type: String, default: '' },
    cancel_reason: { type: String, default: '' },
    dispute: {
      raised_by: { type: String, enum: ['customer', 'vendor', null], default: null },
      reason: { type: String, default: '' },
      raised_at: { type: Date, default: null },
      resolution: { type: String, default: '' },
      // Money given back when support resolved it (delivery fee reduced).
      fee_reduced_by_rwf: { type: Number, min: 0, default: 0 },
      refund_rwf: { type: Number, min: 0, default: 0 },
      refund_id: { type: ObjectId, ref: 'Refund', default: null },
      resolved_at: { type: Date, default: null },
      resolved_by: { type: ObjectId, ref: 'Admin', default: null },
    },
    conversation_id: { type: ObjectId, ref: 'ChatConversation', default: null },
    active_quotation_id: { type: ObjectId, ref: 'DeliveryQuotation', default: null },
    accepted_quotation_id: { type: ObjectId, ref: 'DeliveryQuotation', default: null },
    // Locked when the customer accepts a quotation.
    agreed_fee_rwf: { type: Number, min: 0, default: null },
    agreed_at: { type: Date, default: null },
    quotations_count: { type: Number, min: 0, default: 0 },
  },
  { timestamps }
);

specialDeliveryRequestSchema.index(
  { dedupe_key: 1 },
  { unique: true, partialFilterExpression: { is_active: true }, name: 'one_active_request' }
);
specialDeliveryRequestSchema.index({ customer_id: 1, created_at: -1 });
specialDeliveryRequestSchema.index({ vendor_id: 1, status: 1, created_at: -1 });
specialDeliveryRequestSchema.index({ status: 1, created_at: -1 });
specialDeliveryRequestSchema.index({ order_id: 1 }, { sparse: true });

module.exports = mongoose.model('SpecialDeliveryRequest', specialDeliveryRequestSchema);

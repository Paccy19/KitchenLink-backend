const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const { QUOTATION_STATUSES, ARRANGEMENTS } = require('../config/specialDelivery');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A kitchen's formal delivery price for a special delivery request. Chat
 * messages never set a price: only a quotation the customer accepts does.
 *
 * Quotations are never edited. To change the price the kitchen submits a new
 * version; the previous one becomes 'superseded'. At most one quotation of a
 * request is 'submitted' (open for the customer) at a time.
 */
const deliveryQuotationSchema = new mongoose.Schema(
  {
    request_id: { type: ObjectId, ref: 'SpecialDeliveryRequest', required: true },
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    customer_id: { type: ObjectId, ref: 'Customer', required: true },
    version: { type: Number, min: 1, required: true },
    reference: { type: String, required: true }, // SD-000124-Q2
    fee_rwf: { type: Number, min: 1, required: true },
    destination: {
      address: { type: String, required: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
    proposed_delivery_at: { type: Date, required: true },
    // How the kitchen will deliver (operational detail, not extra charges).
    arrangements: [{ type: String, enum: ARRANGEMENTS.map((a) => a.code) }],
    arrangement_description: { type: String, default: '', trim: true },
    conditions: { type: String, default: '', trim: true },
    valid_until: { type: Date, required: true },
    status: { type: String, enum: QUOTATION_STATUSES, default: 'submitted' },
    submitted_by: { type: ObjectId, ref: 'Vendor', required: true },
    submitted_at: { type: Date, required: true },
    decided_at: { type: Date, default: null },
    decided_by_role: { type: String, enum: ['customer', 'vendor', 'system', 'admin', null], default: null },
    decision_note: { type: String, default: '' },
    status_history: [
      {
        _id: false,
        from: { type: String, default: null },
        to: { type: String, required: true },
        actor_role: { type: String, required: true },
        actor_id: { type: ObjectId, default: null },
        reason: { type: String, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps }
);

deliveryQuotationSchema.index({ request_id: 1, version: 1 }, { unique: true });
// Only one open quotation per request.
deliveryQuotationSchema.index(
  { request_id: 1 },
  { unique: true, partialFilterExpression: { status: 'submitted' }, name: 'one_open_quotation' }
);
deliveryQuotationSchema.index({ status: 1, valid_until: 1 });

module.exports = mongoose.model('DeliveryQuotation', deliveryQuotationSchema);

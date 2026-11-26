const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A kitchen's own record of a customer: an app customer who ordered from it
 * (customer_id), or a regular the cashier added by name and phone. Holds the
 * kitchen's notes, loyalty points and personal discount.
 */
const kitchenCustomerSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    customer_id: { type: ObjectId, ref: 'Customer', default: null },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    tags: [{ type: String, trim: true }],
    loyalty_points: { type: Number, default: 0, min: 0 },
    loyalty_history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        points: { type: Number, required: true },
        reason: { type: String, default: '' },
        invoice_id: { type: ObjectId, ref: 'Invoice', default: null },
        by: { type: String, default: '' },
      },
    ],
    // A standing discount for this customer on bills the kitchen collects (percent).
    discount_percent: { type: Number, min: 0, max: 100, default: 0 },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

kitchenCustomerSchema.index({ vendor_id: 1, customer_id: 1 }, { unique: true, partialFilterExpression: { customer_id: { $type: 'objectId' } } });
kitchenCustomerSchema.index({ vendor_id: 1, phone: 1 });
kitchenCustomerSchema.index({ vendor_id: 1, deleted_at: 1, name: 1 });

module.exports = mongoose.model('KitchenCustomer', kitchenCustomerSchema);

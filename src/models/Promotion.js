const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A discount on bills the kitchen collects itself (dine-in): a code the
 * cashier enters, or an automatic campaign ("10% off the bakery after 5pm").
 * It can cover the whole bill, some products or some departments.
 */
const promotionSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['code', 'automatic'], required: true },
    code: { type: String, default: null, trim: true, uppercase: true },
    discount_type: { type: String, enum: ['percent', 'amount'], required: true },
    value: { type: Number, required: true, min: 0 },
    applies_to: { type: String, enum: ['all', 'products', 'departments'], default: 'all' },
    product_ids: [{ type: ObjectId, ref: 'MenuItem' }],
    department_ids: [{ type: ObjectId, ref: 'Department' }],
    min_order_rwf: { type: Number, min: 0, default: 0 },
    starts_at: { type: Date, default: null },
    ends_at: { type: Date, default: null },
    usage_limit: { type: Number, min: 1, default: null },
    used_count: { type: Number, min: 0, default: 0 },
    is_active: { type: Boolean, default: true },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

promotionSchema.index({ vendor_id: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
promotionSchema.index({ vendor_id: 1, kind: 1, is_active: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);

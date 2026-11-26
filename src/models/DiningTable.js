const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A table in a kitchen. Its QR code opens /menu/<token>: the token is random
 * and unique on the platform (never a database id), so scanning it tells the
 * server the kitchen and the table. Deactivated or removed tables take no orders.
 */
const diningTableSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    label: { type: String, required: true, trim: true },
    // Lower-cased label, unique per kitchen among current tables.
    label_key: { type: String, required: true },
    area: { type: String, default: '', trim: true },
    capacity: { type: Number, min: 1, default: null },
    token: { type: String, required: true, unique: true },
    token_rotated_at: { type: Date, default: null },
    is_active: { type: Boolean, default: true },
    // Server looking after the table (optional).
    assigned_staff_id: { type: ObjectId, ref: 'KitchenStaff', default: null },
    is_current: { type: Boolean, default: true },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

diningTableSchema.index({ vendor_id: 1, label_key: 1 }, { unique: true, partialFilterExpression: { is_current: true } });

module.exports = mongoose.model('DiningTable', diningTableSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

const seatSchema = new mongoose.Schema(
  {
    seat_number: { type: Number, required: true, min: 1 },
    token: { type: String, required: true },
    previous_tokens: [
      {
        _id: false,
        token: { type: String, required: true },
        valid_until: { type: Date, required: true },
      },
    ],
    is_active: { type: Boolean, default: true },
    token_rotated_at: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * A table in a kitchen. Its QR code opens /menu/<token>: the token is random
 * and opaque, so scanning it tells the server the kitchen, table and (for seat
 * tokens) the individual seat. Deactivated or removed tables take no orders.
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
    seats: { type: [seatSchema], default: [] },
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
diningTableSchema.index({ 'seats.token': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('DiningTable', diningTableSchema);

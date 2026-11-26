const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A booked table: who, how many, when, and (once assigned) which table. */
const reservationSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    party_size: { type: Number, min: 1, max: 200, required: true },
    starts_at: { type: Date, required: true },
    duration_minutes: { type: Number, min: 15, max: 720, default: 90 },
    ends_at: { type: Date, required: true },
    table_id: { type: ObjectId, ref: 'DiningTable', default: null },
    table_label: { type: String, default: '' },
    status: { type: String, enum: ['booked', 'seated', 'completed', 'cancelled', 'no_show'], default: 'booked' },
    notes: { type: String, default: '', trim: true },
    kitchen_customer_id: { type: ObjectId, ref: 'KitchenCustomer', default: null },
    created_by: { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } },
    seated_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
  },
  { timestamps }
);

reservationSchema.index({ vendor_id: 1, starts_at: 1 });
reservationSchema.index({ table_id: 1, starts_at: 1, ends_at: 1 });

module.exports = mongoose.model('Reservation', reservationSchema);

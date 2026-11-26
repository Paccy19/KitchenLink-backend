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
    // pending (asked online) -> confirmed -> arrived -> seated -> completed;
    // or cancelled / rejected / no_show. ('booked' = confirmed, older records.)
    status: { type: String, enum: ['pending', 'confirmed', 'booked', 'arrived', 'seated', 'completed', 'cancelled', 'rejected', 'no_show'], default: 'confirmed' },
    email: { type: String, default: '', trim: true },
    special_requests: { type: String, default: '', trim: true },
    dietary_notes: { type: String, default: '', trim: true },
    // 'staff' (entered by the host) or 'online' (the kitchen's public page).
    source: { type: String, enum: ['staff', 'online'], default: 'staff' },
    customer_id: { type: ObjectId, ref: 'Customer', default: null },
    // Lets the guest view or cancel their online booking (only the hash is kept).
    token_hash: { type: String, default: null, select: false },
    // Ordered ahead: prepared at arrival (or the configured time before).
    preorder_items: [
      {
        _id: false,
        menu_item_id: { type: ObjectId, ref: 'MenuItem', required: true },
        name: { type: String, default: '' },
        quantity: { type: Number, min: 1, max: 50, required: true },
        note: { type: String, default: '' },
      },
    ],
    preorder_order_id: { type: ObjectId, ref: 'Order', default: null },
    deposit: {
      required_rwf: { type: Number, min: 0, default: 0 },
      paid_rwf: { type: Number, min: 0, default: 0 },
      // How much of it is already counted on the table's bill.
      applied_rwf: { type: Number, min: 0, default: 0 },
      method: { type: String, default: '' },
      reference: { type: String, default: '' },
      paid_at: { type: Date, default: null },
      // none | required | paid | applied (to the bill) | refunded | forfeited
      status: { type: String, default: 'none' },
      settled_at: { type: Date, default: null },
      note: { type: String, default: '' },
    },
    session_id: { type: ObjectId, ref: 'TableSession', default: null },
    confirmed_at: { type: Date, default: null },
    arrived_at: { type: Date, default: null },
    reminder_sent_at: { type: Date, default: null },
    history: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: String, default: '' }, note: { type: String, default: '' } }],
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
reservationSchema.index({ token_hash: 1 }, { sparse: true });
reservationSchema.index({ session_id: 1 }, { sparse: true });

module.exports = mongoose.model('Reservation', reservationSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;
const actor = { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } };

/**
 * A visit at a table: from seating (by the host, a reservation, or the first
 * QR order) to closing. Holds the server, the guests, every order placed at
 * the table during the visit and its bill.
 *   open            seated, nothing ordered yet
 *   active          orders in progress
 *   awaiting_payment everything served, bill not settled
 *   closing         closure requested
 *   closed
 */
const tableSessionSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    table_id: { type: ObjectId, ref: 'DiningTable', required: true },
    table_label: { type: String, default: '' },
    status: { type: String, enum: ['open', 'active', 'awaiting_payment', 'closing', 'closed'], default: 'open' },
    guest_count: { type: Number, min: 1, max: 200, default: null },
    customer_name: { type: String, default: '', trim: true },
    customer_phone: { type: String, default: '', trim: true },
    kitchen_customer_id: { type: ObjectId, ref: 'KitchenCustomer', default: null },
    reservation_id: { type: ObjectId, ref: 'Reservation', default: null },
    server_id: { type: ObjectId, ref: 'KitchenStaff', default: null },
    server_name: { type: String, default: '' },
    // How it started: 'host' (seated), 'reservation', 'qr' (first scan), 'staff' (ordered by a server).
    source: { type: String, enum: ['host', 'reservation', 'qr', 'staff'], default: 'host' },
    order_ids: [{ type: ObjectId, ref: 'Order' }],
    invoice_id: { type: ObjectId, ref: 'Invoice', default: null },
    notes: { type: String, default: '', trim: true },
    transfers: [{ _id: false, from_label: String, to_label: String, at: { type: Date, default: Date.now }, by: { type: String, default: '' } }],
    started_at: { type: Date, default: Date.now },
    started_by: actor,
    close_requested_at: { type: Date, default: null },
    closed_at: { type: Date, default: null },
    closed_by: actor,
    // What was still open when it was closed (a manager allowed it).
    close_exceptions: [{ type: String }],
    // Kept true while the session is not closed: one live session per table.
    is_live: { type: Boolean, default: true },
  },
  { timestamps }
);

tableSessionSchema.index({ vendor_id: 1, status: 1, started_at: -1 });
tableSessionSchema.index({ table_id: 1 }, { unique: true, partialFilterExpression: { is_live: true }, name: 'one_live_session_per_table' });

module.exports = mongoose.model('TableSession', tableSessionSchema);

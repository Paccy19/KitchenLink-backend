const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;
const actor = { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } };

const customerSessionSchema = new mongoose.Schema(
  {
    seat_number: { type: Number, required: true, min: 1 },
    customer_id: { type: ObjectId, ref: 'Customer', default: null },
    guest_name: { type: String, default: '' },
    key_hash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'closed', 'expired'], default: 'active' },
    started_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true },
    closed_at: { type: Date, default: null },
  },
  { _id: true }
);

const paymentAuthorizationSchema = new mongoose.Schema(
  {
    beneficiary_customer_session_id: { type: ObjectId, required: true },
    payer_customer_session_id: { type: ObjectId, default: null },
    token_hash: { type: String, default: null },
    status: { type: String, enum: ['pending', 'authorized', 'revoked', 'expired'], default: 'pending' },
    created_at: { type: Date, default: Date.now },
    authorized_at: { type: Date, default: null },
    expires_at: { type: Date, required: true },
    revoked_at: { type: Date, default: null },
  },
  { _id: true }
);

/**
 * One physical table visit, from seating (by the host, a reservation, or the
 * first QR order) to closing.
 *
 * - Guests' seat sessions stay separate within it (`customer_sessions`), so
 *   guests sharing a table never share identity or order ownership
 *   implicitly, and one guest can pay for another only when allowed
 *   (`payment_authorizations`).
 * - The floor side: party size, server, reservation, moves between tables,
 *   and how it was closed (`close_exceptions` when a manager overrode the rules).
 *
 * `status` is 'active' until it closes (one active visit per table); how far
 * the visit is (seated, eating, waiting to pay) is worked out from its orders.
 * Orders point to it with `Order.table_session_id`.
 */
const tableSessionSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    table_id: { type: ObjectId, ref: 'DiningTable', required: true },
    table_label: { type: String, default: '' },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    customer_sessions: { type: [customerSessionSchema], default: [] },
    payment_authorizations: { type: [paymentAuthorizationSchema], default: [] },
    guest_count: { type: Number, min: 1, max: 200, default: null },
    customer_name: { type: String, default: '', trim: true },
    customer_phone: { type: String, default: '', trim: true },
    kitchen_customer_id: { type: ObjectId, ref: 'KitchenCustomer', default: null },
    reservation_id: { type: ObjectId, ref: 'Reservation', default: null },
    server_id: { type: ObjectId, ref: 'KitchenStaff', default: null },
    server_name: { type: String, default: '' },
    // How it started: 'host' (seated), 'reservation', 'qr' (first scan), 'staff' (ordered by a server).
    source: { type: String, enum: ['host', 'reservation', 'qr', 'staff'], default: 'qr' },
    order_ids: [{ type: ObjectId, ref: 'Order' }],
    invoice_id: { type: ObjectId, ref: 'Invoice', default: null },
    notes: { type: String, default: '', trim: true },
    transfers: [{ _id: false, from_label: String, to_label: String, at: { type: Date, default: Date.now }, by: { type: String, default: '' } }],
    started_at: { type: Date, default: Date.now },
    started_by: actor,
    closed_at: { type: Date, default: null },
    closed_by: actor,
    // What was still open when it was closed (a manager allowed it).
    close_exceptions: [{ type: String }],
  },
  { timestamps }
);

tableSessionSchema.index(
  { vendor_id: 1, table_id: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_table_session' }
);
tableSessionSchema.index({ vendor_id: 1, table_id: 1, started_at: -1 });
tableSessionSchema.index({ vendor_id: 1, status: 1, started_at: -1 });

module.exports = mongoose.model('TableSession', tableSessionSchema);

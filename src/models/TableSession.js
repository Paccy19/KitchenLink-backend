const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

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
 * One physical table visit. Customer sessions stay separate within it, so
 * guests sharing a table never share identity or order ownership implicitly.
 */
const tableSessionSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    table_id: { type: ObjectId, ref: 'DiningTable', required: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    customer_sessions: { type: [customerSessionSchema], default: [] },
    payment_authorizations: { type: [paymentAuthorizationSchema], default: [] },
    started_at: { type: Date, default: Date.now },
    closed_at: { type: Date, default: null },
  },
  { timestamps }
);

tableSessionSchema.index(
  { vendor_id: 1, table_id: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_table_session' }
);
tableSessionSchema.index({ vendor_id: 1, table_id: 1, started_at: -1 });

module.exports = mongoose.model('TableSession', tableSessionSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

const paymentSchema = new mongoose.Schema(
  {
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required() {
        return !this.table_session_id;
      },
      default: null,
      index: true,
    },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required() {
        return !this.table_session_id;
      },
      default: null,
    },
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
    table_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DiningTable', default: null },
    table_session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null, index: true },
    payer_customer_session_id: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    idempotency_scope: { type: String, default: null },
    idempotency_key_hash: { type: String, default: null },
    request_hash: { type: String, default: null },
    allocations: [
      {
        order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
        invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
        customer_session_id: { type: mongoose.Schema.Types.ObjectId, required: true },
        seat_number: { type: Number, min: 1, required: true },
        amount_rwf: { type: Number, min: 1, required: true },
        authorization_id: { type: mongoose.Schema.Types.ObjectId, default: null },
        balance_version: { type: String, required: true },
      },
    ],
    allocation_status: { type: String, enum: ['pending', 'allocated'], default: null },
    amount_rwf: { type: Number, required: true },
    method: {
      type: String,
      enum: [...config.orders.paymentMethods.map((m) => m.code), 'cash', 'other'],
      required: true,
    },
    provider: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'successful', 'failed', 'refunded'],
      default: 'pending',
    },
    reference: { type: String, required: true, unique: true },
    failure_reason: { type: String, default: '' },
    paid_at: { type: Date },
    // What this payment covers: the whole order, a big event's deposit, or its balance.
    part: { type: String, enum: ['full', 'deposit', 'balance'], default: 'full' },
    // The payment provider's own transaction id (Paypack's ref).
    provider_reference: { type: String, index: true, sparse: true },
    received_by: {
      type: new mongoose.Schema(
        {
          type: { type: String, enum: ['owner', 'staff', 'system'], default: 'system' },
          id: { type: String, default: null },
          name: { type: String, default: '' },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    allocated_at: { type: Date, default: null },
  },
  { timestamps }
);

paymentSchema.index({ order_id: 1, created_at: -1 });
paymentSchema.index(
  { payer_customer_session_id: 1, idempotency_key_hash: 1 },
  {
    unique: true,
    partialFilterExpression: { table_session_id: { $type: 'objectId' }, idempotency_key_hash: { $type: 'string' } },
    name: 'unique_seat_payment_idempotency',
  }
);
paymentSchema.index(
  { idempotency_scope: 1, idempotency_key_hash: 1 },
  {
    unique: true,
    partialFilterExpression: { table_session_id: { $type: 'objectId' }, idempotency_scope: { $type: 'string' }, idempotency_key_hash: { $type: 'string' } },
    name: 'unique_table_payment_scope_idempotency',
  }
);
paymentSchema.index({ table_session_id: 1, status: 1, created_at: -1 });

module.exports = mongoose.model('Payment', paymentSchema);

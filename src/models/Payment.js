const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

const paymentSchema = new mongoose.Schema(
  {
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    amount_rwf: { type: Number, required: true },
    method: {
      type: String,
      enum: config.orders.paymentMethods.map((m) => m.code),
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
  },
  { timestamps }
);

paymentSchema.index({ order_id: 1, created_at: -1 });

module.exports = mongoose.model('Payment', paymentSchema);

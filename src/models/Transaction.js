const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Immutable money ledger. Every movement around the platform account is
 * recorded here: customer payments held, vendor/rider payouts released,
 * commission retained, and refunds.
 */
const TRANSACTION_TYPES = [
  'order_payment',
  'vendor_payout',
  'driver_payout',
  'commission',
  'refund',
];

const transactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TRANSACTION_TYPES, required: true, index: true },
    // credit = money into the platform account, debit = money out of it.
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    status: {
      type: String,
      enum: ['held', 'settled', 'refunded'],
      default: 'settled',
    },
    amount_rwf: { type: Number, required: true },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true,
    },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    driver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps }
);

transactionSchema.index({ created_at: -1 });
transactionSchema.index({ type: 1, created_at: -1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
Transaction.TRANSACTION_TYPES = TRANSACTION_TYPES;

module.exports = Transaction;

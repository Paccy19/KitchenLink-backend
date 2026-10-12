const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Immutable money ledger.
 *
 * Cash movements (`credit` = money into the platform's account, `debit` = money
 * out of it): customer payments (`order_payment`), refunds (`refund`) and
 * payouts actually sent to vendors/riders (`withdrawal`).
 *
 * Allocations (`internal`, no cash moves): when an order completes, held money
 * is split into the platform's `commission`, what the platform now owes the
 * vendor (`vendor_earning`) and, once a rider delivers it, what it owes the
 * rider (`driver_earning`). Owed money leaves only when it is withdrawn.
 */
const TRANSACTION_TYPES = [
  'order_payment',
  'vendor_earning',
  'driver_earning',
  'commission',
  'refund',
  // Owner's corrections to the platform's commission (e.g. writing off a
  // loss); signed amount, applied to the commission balance.
  'adjustment',
  // Commission the owner actually withdrew from the platform's account.
  'platform_withdrawal',
  // Legacy names of vendor_earning / driver_earning (migrated at startup).
  'vendor_payout',
  'driver_payout',
  // Money actually sent out to a vendor/driver when an admin completes a
  // withdrawal (their earnings were booked as payouts at order completion).
  'withdrawal',
];

const transactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TRANSACTION_TYPES, required: true, index: true },
    // credit/debit = cash into/out of the platform account; internal = allocation.
    direction: { type: String, enum: ['credit', 'debit', 'internal'], required: true },
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

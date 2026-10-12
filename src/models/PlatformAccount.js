const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * The platform (system admin) money account. Customer payments are collected
 * into `held_balance_rwf` (escrow). When an order completes, the platform
 * retains its commission (`commission_balance_rwf`) and releases the rest to
 * the vendor and the rider. A single row keyed "primary" holds the balances.
 */
const platformAccountSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    // Customer money collected but not yet settled to vendors/riders.
    held_balance_rwf: { type: Number, default: 0 },
    // Commission retained by the platform (system admin revenue).
    commission_balance_rwf: { type: Number, default: 0 },
    // Running lifetime totals for reporting.
    total_collected_rwf: { type: Number, default: 0 },
    total_commission_rwf: { type: Number, default: 0 },
    total_vendor_payouts_rwf: { type: Number, default: 0 },
    total_driver_payouts_rwf: { type: Number, default: 0 },
    total_refunded_rwf: { type: Number, default: 0 },
  },
  { timestamps }
);

module.exports = mongoose.model('PlatformAccount', platformAccountSchema);

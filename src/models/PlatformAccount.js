const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * The platform's books, as last computed by `platformLedgerService.snapshot()`
 * from the ledger, orders and vendor/rider balances (the sources of truth).
 * A single row keyed "primary".
 *
 * All customer money sits in one real account (`cash_balance_rwf`), which must
 * equal what it is made of:
 *   held (orders in progress) + owed to vendors + owed to riders + commission
 * `unreconciled_rwf` is the difference and should always be 0.
 */
const platformAccountSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    // Money that should physically be in the platform's account right now.
    cash_balance_rwf: { type: Number, default: 0 },
    // What that cash is made of.
    held_balance_rwf: { type: Number, default: 0 },
    vendor_payable_rwf: { type: Number, default: 0 },
    driver_payable_rwf: { type: Number, default: 0 },
    // The owner's money: commission + adjustments - withdrawn by the owner.
    commission_balance_rwf: { type: Number, default: 0 },
    unreconciled_rwf: { type: Number, default: 0 },
    total_adjustments_rwf: { type: Number, default: 0 },
    total_owner_withdrawn_rwf: { type: Number, default: 0 },
    owner_processing_rwf: { type: Number, default: 0 },
    // Last weekly sweep reminder (ISO week like "2026-W41").
    last_sweep_week: { type: String, default: '' },
    last_sweep_at: { type: Date, default: null },
    last_sweep_amount_rwf: { type: Number, default: 0 },
    // Lifetime totals.
    total_collected_rwf: { type: Number, default: 0 },
    total_refunded_rwf: { type: Number, default: 0 },
    total_commission_rwf: { type: Number, default: 0 },
    total_vendor_earnings_rwf: { type: Number, default: 0 },
    total_driver_earnings_rwf: { type: Number, default: 0 },
    // Actually paid out (completed withdrawals).
    total_vendor_payouts_rwf: { type: Number, default: 0 },
    total_driver_payouts_rwf: { type: Number, default: 0 },
    computed_at: { type: Date, default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('PlatformAccount', platformAccountSchema);

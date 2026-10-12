const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * A company account the owner's commission may be withdrawn to (bank account
 * or business mobile money). Destinations are locked: a new one can only be
 * used after `activates_at` (a cooldown), and removing one is permanent.
 */
const payoutDestinationSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: ['bank', 'mobile_money'], required: true },
    // Bank name (e.g. "Bank of Kigali") or network ("MTN Mobile Money").
    provider: { type: String, required: true, trim: true },
    account_name: { type: String, required: true, trim: true },
    account_number: { type: String, required: true, trim: true },
    status: { type: String, enum: ['active', 'removed'], default: 'active', index: true },
    activates_at: { type: Date, required: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    removed_at: { type: Date, default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('PayoutDestination', payoutDestinationSchema);

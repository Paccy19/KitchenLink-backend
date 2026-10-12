const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * The owner withdrawing the platform's commission to a company account.
 * `processing` reserves the amount until the owner confirms the transfer they
 * made (`completed`, with its reference) or cancels it (`failed`).
 */
const platformWithdrawalSchema = new mongoose.Schema(
  {
    amount_rwf: { type: Number, required: true, min: 1 },
    destination_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayoutDestination',
      required: true,
    },
    // Snapshot of where the money goes, kept even if the destination is removed.
    destination: {
      label: String,
      type: { type: String },
      provider: String,
      account_name: String,
      account_number: String,
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },
    // 'weekly_sweep' when started from the reminder; 'auto' when created by the
    // owner's saved automatic-withdrawal schedule.
    source: { type: String, enum: ['manual', 'weekly_sweep', 'auto'], default: 'manual' },
    // Payout service used and its own transaction id (automatic transfers).
    provider: { type: String, default: 'manual' },
    reference: { type: String, default: '' },
    failure_reason: { type: String, default: '' },
    requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    processed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    processed_at: { type: Date, default: null },
  },
  { timestamps }
);

platformWithdrawalSchema.index({ created_at: -1 });
// At most one withdrawal can be in progress at a time.
platformWithdrawalSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: 'processing' }, name: 'one_processing' }
);

module.exports = mongoose.model('PlatformWithdrawal', platformWithdrawalSchema);

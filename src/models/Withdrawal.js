const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * A vendor payout request against their available balance.
 * Amounts are stored in RWF (whole francs).
 */
const withdrawalSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    amount_rwf: { type: Number, required: true, min: 1 },
    method: {
      type: String,
      enum: ['mobile_money', 'bank_transfer', 'cash', 'other'],
      default: 'mobile_money',
    },
    method_label: { type: String, default: '' },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },
    reference: { type: String, default: '' },
    processed_at: { type: Date, default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

withdrawalSchema.index({ vendor_id: 1, created_at: -1 });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);

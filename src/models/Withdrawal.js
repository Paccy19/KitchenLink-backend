const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * A payout request against a vendor's or a driver's available balance.
 * The amount is reserved (deducted) when requested, paid out by an admin
 * (`completed`), or returned to the balance if the payout `failed`.
 * Amounts are stored in RWF (whole francs).
 */
const withdrawalSchema = new mongoose.Schema(
  {
    payee_type: {
      type: String,
      enum: ['vendor', 'driver'],
      default: 'vendor',
      index: true,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
      index: true,
    },
    driver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
      index: true,
    },
    amount_rwf: { type: Number, required: true, min: 1 },
    method: {
      type: String,
      enum: ['mobile_money', 'bank_transfer', 'cash', 'other'],
      default: 'mobile_money',
    },
    method_label: { type: String, default: '' },
    // Where the admin should send the money (e.g. the MoMo number).
    account_number: { type: String, default: '' },
    account_name: { type: String, default: '' },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },
    reference: { type: String, default: '' },
    failure_reason: { type: String, default: '' },
    processed_at: { type: Date, default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

withdrawalSchema.pre('validate', function requirePayee() {
  const owner = this.payee_type === 'driver' ? this.driver_id : this.vendor_id;
  if (!owner) {
    this.invalidate(
      this.payee_type === 'driver' ? 'driver_id' : 'vendor_id',
      `${this.payee_type}_id is required`
    );
  }
});

withdrawalSchema.index({ vendor_id: 1, created_at: -1 });
withdrawalSchema.index({ driver_id: 1, created_at: -1 });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * The owner's saved payout preferences (single row keyed "primary"): which
 * company account receives commission (a bank account or a mobile money
 * number) and when withdrawals happen. Saved with an SMS code; the chosen
 * account is a locked PayoutDestination (cooldown before first use).
 */
const ownerPayoutSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    method: { type: String, enum: ['bank', 'mobile_money', null], default: null },
    destination_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutDestination', default: null },
    schedule: {
      // off: nothing; reminder: SMS + notification only; auto: create (and,
      // with a payout service, send) the withdrawal automatically.
      mode: { type: String, enum: ['off', 'reminder', 'auto'], default: 'reminder' },
      frequency: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
      weekday: { type: Number, min: 0, max: 6, default: 5 },
      day_of_month: { type: Number, min: 1, max: 28, default: 1 },
      hour: { type: Number, min: 0, max: 23, default: 9 },
      amount_mode: { type: String, enum: ['all_available', 'fixed'], default: 'all_available' },
      fixed_amount_rwf: { type: Number, min: 0, default: 0 },
    },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('OwnerPayoutSettings', ownerPayoutSettingsSchema);

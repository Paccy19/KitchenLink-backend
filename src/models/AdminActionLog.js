const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Immutable audit trail of admin actions. Written by the audit middleware /
 * service whenever an admin performs a state-changing operation.
 */
const adminActionLogSchema = new mongoose.Schema(
  {
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    admin_name: { type: String, default: '' },
    admin_email: { type: String, default: '' },
    action: { type: String, required: true },
    target_type: {
      type: String,
      enum: [
        'vendor',
        'customer',
        'driver',
        'order',
        'payment',
        'commission',
        'payout',
        'withdrawal',
        'delivery',
        'category',
        'complaint',
        'admin',
        'system',
        // The owner's platform money.
        'platform_withdrawal',
        'payout_destination',
        'transaction',
        'reconciliation',
        'refund',
        'admin_member',
      ],
      default: 'system',
    },
    target_id: { type: String, default: '' },
    target_label: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
  },
  { timestamps }
);

adminActionLogSchema.index({ created_at: -1 });
adminActionLogSchema.index({ admin_id: 1, created_at: -1 });
adminActionLogSchema.index({ target_type: 1, target_id: 1 });

module.exports = mongoose.model('AdminActionLog', adminActionLogSchema);

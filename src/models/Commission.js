const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Commission configuration. The most specific active scope wins:
 * vendor > category > vendor_type > global. Each row carries the platform
 * cut (percentage) and an optional flat fee retained per order (RWF).
 */
const COMMISSION_SCOPES = ['global', 'vendor', 'category', 'vendor_type'];

const commissionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    scope: { type: String, enum: COMMISSION_SCOPES, default: 'global', index: true },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    vendor_type: { type: String, default: '' },
    percentage: { type: Number, min: 0, max: 100, default: 0 },
    fixed_fee_rwf: { type: Number, min: 0, default: 0 },
    is_active: { type: Boolean, default: true },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

commissionSchema.index({ scope: 1, is_active: 1 });

module.exports = mongoose.model('Commission', commissionSchema);
module.exports.COMMISSION_SCOPES = COMMISSION_SCOPES;

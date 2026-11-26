const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const actor = { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } };

/**
 * A cashier's shift at the till: the cash they started with, then at closing
 * the cash they counted against what the payments they took say it should be.
 */
const cashierSessionSchema = new mongoose.Schema(
  {
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    cashier: actor,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    opened_at: { type: Date, default: Date.now },
    opening_float_rwf: { type: Number, min: 0, default: 0 },
    closed_at: { type: Date, default: null },
    closed_by: actor,
    counted_cash_rwf: { type: Number, min: 0, default: null },
    expected_cash_rwf: { type: Number, default: null },
    difference_rwf: { type: Number, default: null },
    totals_by_method: { type: mongoose.Schema.Types.Mixed, default: {} },
    payments_count: { type: Number, default: 0 },
    refunds_rwf: { type: Number, default: 0 },
    notes: { type: String, default: '' },
  },
  { timestamps }
);

cashierSessionSchema.index({ vendor_id: 1, status: 1, opened_at: -1 });
// One open till per cashier.
cashierSessionSchema.index({ vendor_id: 1, 'cashier.id': 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

module.exports = mongoose.model('CashierSession', cashierSessionSchema);

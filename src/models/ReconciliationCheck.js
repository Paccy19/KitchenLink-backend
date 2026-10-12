const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * A monthly (or ad-hoc) check of the real account statement against the cash
 * the system says should be in the platform's account.
 */
const reconciliationCheckSchema = new mongoose.Schema(
  {
    account_label: { type: String, required: true, trim: true },
    statement_date: { type: Date, required: true },
    statement_balance_rwf: { type: Number, required: true },
    system_cash_rwf: { type: Number, required: true },
    // statement - system; 0 means the real account matches the books.
    difference_rwf: { type: Number, required: true },
    note: { type: String, default: '' },
    recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

reconciliationCheckSchema.index({ statement_date: -1 });

module.exports = mongoose.model('ReconciliationCheck', reconciliationCheckSchema);

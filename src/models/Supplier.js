const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/** Someone a kitchen buys stock from. */
const supplierSchema = new mongoose.Schema(
  {
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    name: { type: String, required: true, trim: true },
    contact_name: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('Supplier', supplierSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** Money the kitchen spent (rent, salaries, gas, stock bought …), for profit and loss. */
const expenseSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    date: { type: Date, required: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    amount_rwf: { type: Number, required: true, min: 1 },
    department_id: { type: ObjectId, ref: 'Department', default: null },
    supplier_id: { type: ObjectId, ref: 'Supplier', default: null },
    payment_method: { type: String, default: 'cash' },
    reference: { type: String, default: '', trim: true },
    // Created by receiving a purchase order (not typed by hand).
    purchase_order_id: { type: ObjectId, ref: 'PurchaseOrder', default: null },
    recorded_by: { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

expenseSchema.index({ vendor_id: 1, deleted_at: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);

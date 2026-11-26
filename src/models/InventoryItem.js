const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** A stock item (coffee beans, flour, cups …), kitchen-wide or owned by one department. */
const inventoryItemSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    department_id: { type: ObjectId, ref: 'Department', default: null },
    name: { type: String, required: true, trim: true },
    unit: { type: String, default: 'pcs', trim: true },
    sku: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0 },
    low_stock_threshold: { type: Number, min: 0, default: 0 },
    cost_per_unit_rwf: { type: Number, min: 0, default: 0 },
    supplier_id: { type: ObjectId, ref: 'Supplier', default: null },
    // Set while below the threshold, so the low-stock alert is sent once.
    low_stock_alerted_at: { type: Date, default: null },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

inventoryItemSchema.index({ vendor_id: 1, deleted_at: 1, department_id: 1, name: 1 });

module.exports = mongoose.model('InventoryItem', inventoryItemSchema);

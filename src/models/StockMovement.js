const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** Every change to a stock level, with who made it and why. Never edited. */
const stockMovementSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    item_id: { type: ObjectId, ref: 'InventoryItem', required: true },
    department_id: { type: ObjectId, ref: 'Department', default: null },
    delta: { type: Number, required: true },
    quantity_after: { type: Number, required: true },
    reason: { type: String, enum: ['purchase', 'adjustment', 'waste', 'usage', 'order', 'initial', 'return', 'transfer_in', 'transfer_out'], required: true },
    purchase_order_id: { type: ObjectId, ref: 'PurchaseOrder', default: null },
    note: { type: String, default: '' },
    order_id: { type: ObjectId, ref: 'Order', default: null },
    order_number: { type: String, default: '' },
    supplier_id: { type: ObjectId, ref: 'Supplier', default: null },
    actor: {
      type: { type: String, enum: ['owner', 'staff', 'system'], default: 'system' },
      id: { type: String, default: null },
      name: { type: String, default: '' },
    },
  },
  { timestamps }
);

stockMovementSchema.index({ vendor_id: 1, created_at: -1 });
stockMovementSchema.index({ item_id: 1, created_at: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);

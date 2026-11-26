const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const { ObjectId } = mongoose.Schema.Types;

/** An order to a supplier for stock. Receiving it adds the stock and records the expense. */
const purchaseOrderSchema = new mongoose.Schema(
  {
    vendor_id: { type: ObjectId, ref: 'Vendor', required: true },
    number: { type: String, required: true },
    supplier_id: { type: ObjectId, ref: 'Supplier', default: null },
    status: { type: String, enum: ['draft', 'sent', 'partially_received', 'received', 'cancelled'], default: 'draft' },
    lines: [
      {
        item_id: { type: ObjectId, ref: 'InventoryItem', required: true },
        name: { type: String, required: true },
        unit: { type: String, default: '' },
        quantity: { type: Number, required: true, min: 0 },
        unit_cost_rwf: { type: Number, default: 0, min: 0 },
        received_quantity: { type: Number, default: 0, min: 0 },
      },
    ],
    total_rwf: { type: Number, default: 0, min: 0 },
    expected_at: { type: Date, default: null },
    notes: { type: String, default: '', trim: true },
    created_by: { type: { type: String, default: null }, id: { type: String, default: null }, name: { type: String, default: '' } },
    sent_at: { type: Date, default: null },
    received_at: { type: Date, default: null },
  },
  { timestamps }
);

purchaseOrderSchema.index({ vendor_id: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ vendor_id: 1, status: 1, created_at: -1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);

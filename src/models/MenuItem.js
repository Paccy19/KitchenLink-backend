const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const menuItemSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    // The department that prepares it (null = the kitchen as a whole).
    department_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    price_rwf: { type: Number, required: true, min: 0 },
    preparation_time_minutes: { type: Number, min: 0, default: 0 },
    is_available: { type: Boolean, default: true },
    is_preorder: { type: Boolean, default: false },
    preorder_cutoff: { type: String, default: '' },
    is_popular: { type: Boolean, default: false },
    image_url: { type: String, default: '' },
    // Shown on the department's preparation ticket.
    preparation_notes: { type: String, default: '', trim: true },
    // What one portion uses from stock (only deducted when the kitchen turns
    // on automatic stock deduction).
    recipe: [
      {
        _id: false,
        inventory_item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
        quantity: { type: Number, required: true, min: 0 },
      },
    ],
    orders_count: { type: Number, default: 0, min: 0 },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

menuItemSchema.index({ vendor_id: 1, category_id: 1 });
menuItemSchema.index({ vendor_id: 1, department_id: 1 });
menuItemSchema.index({ vendor_id: 1, deleted_at: 1, created_at: -1 });
menuItemSchema.index({ category_id: 1, is_available: 1 });
menuItemSchema.index({ is_available: 1, orders_count: -1 });
menuItemSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);

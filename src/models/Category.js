const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    icon_url: { type: String, default: '' },
    description: { type: String, default: '' },
    sort_order: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    // Vendor type codes this category is meant for (e.g. ['bakery'] for
    // Breads). Empty = a general category that suits every type. Soft
    // guidance only: any kitchen may still use any category.
    vendor_types: { type: [String], default: [] },
    // Set when a kitchen created the category from its menu (null = admin).
    created_by_vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    created_by_vendor_name: { type: String, default: '' },
  },
  { timestamps }
);

categorySchema.index({ sort_order: 1, name: 1 });
categorySchema.index({ name: 'text' });

module.exports = mongoose.model('Category', categorySchema);

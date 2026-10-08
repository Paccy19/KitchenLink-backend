const mongoose = require('mongoose');

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
      required: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    price_rwf: { type: Number, required: true, min: 0 },
    is_available: { type: Boolean, default: true },
    image_url: { type: String, default: '' },
    orders_count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

menuItemSchema.index({ vendor_id: 1, category_id: 1 });
menuItemSchema.index({ category_id: 1, is_available: 1 });
menuItemSchema.index({ is_available: 1, orders_count: -1 });
menuItemSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);

const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * A selectable option attached to a menu item, e.g. "Size: Large (+1,000)"
 * or "Extra: Avocado (+500)". Grouped by group_name for display.
 */
const menuItemOptionSchema = new mongoose.Schema(
  {
    menu_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
      index: true,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    group_name: { type: String, default: 'Options', trim: true },
    name: { type: String, required: true, trim: true },
    additional_price_rwf: { type: Number, min: 0, default: 0 },
    is_available: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

menuItemOptionSchema.index({ menu_item_id: 1, deleted_at: 1, sort_order: 1 });
menuItemOptionSchema.index({ vendor_id: 1 });

module.exports = mongoose.model('MenuItemOption', menuItemOptionSchema);

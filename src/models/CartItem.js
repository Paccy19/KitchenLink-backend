const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    menu_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    quantity: { type: Number, required: true, min: 1, default: 1 },
  },
  { timestamps: true }
);

cartItemSchema.index({ customer_id: 1, menu_item_id: 1 }, { unique: true });
cartItemSchema.index({ customer_id: 1, vendor_id: 1 });

module.exports = mongoose.model('CartItem', cartItemSchema);

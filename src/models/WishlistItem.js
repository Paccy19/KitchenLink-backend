const mongoose = require('mongoose');

const wishlistItemSchema = new mongoose.Schema(
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
  },
  { timestamps: true }
);

wishlistItemSchema.index({ customer_id: 1, menu_item_id: 1 }, { unique: true });
wishlistItemSchema.index({ customer_id: 1, created_at: -1 });

module.exports = mongoose.model('WishlistItem', wishlistItemSchema);

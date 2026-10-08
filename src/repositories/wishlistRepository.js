const { WishlistItem } = require('../models');

class WishlistRepository {
  async list(customerId) {
    return WishlistItem.find({ customer_id: customerId })
      .sort({ created_at: -1 })
      .populate({
        path: 'menu_item_id',
        select: 'name price_rwf image_url is_available vendor_id category_id',
        populate: {
          path: 'vendor_id',
          select: 'name vendor_type neighborhood delivery_available',
        },
      })
      .lean();
  }

  async findByCustomerAndItem(customerId, menuItemId) {
    return WishlistItem.findOne({
      customer_id: customerId,
      menu_item_id: menuItemId,
    }).lean();
  }

  async add(customerId, menuItemId) {
    const doc = await WishlistItem.findOneAndUpdate(
      { customer_id: customerId, menu_item_id: menuItemId },
      { $setOnInsert: { customer_id: customerId, menu_item_id: menuItemId } },
      { new: true, upsert: true }
    );
    return doc;
  }

  async remove(customerId, menuItemId) {
    const result = await WishlistItem.deleteOne({
      customer_id: customerId,
      menu_item_id: menuItemId,
    });
    return result.deletedCount > 0;
  }
}

module.exports = new WishlistRepository();

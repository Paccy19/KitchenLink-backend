const { CartItem } = require('../models');

class CartRepository {
  async list(customerId) {
    return CartItem.find({ customer_id: customerId })
      .sort({ created_at: 1 })
      .populate({
        path: 'menu_item_id',
        select: 'name price_rwf image_url is_available vendor_id description',
      })
      .populate('vendor_id', 'name vendor_type banner_image_url delivery_available')
      .lean();
  }

  async findByCustomerAndItem(customerId, menuItemId) {
    return CartItem.findOne({
      customer_id: customerId,
      menu_item_id: menuItemId,
    }).lean();
  }

  async findOtherVendorItems(customerId, vendorId) {
    return CartItem.find({
      customer_id: customerId,
      vendor_id: { $ne: vendorId },
    })
      .populate('vendor_id', 'name')
      .lean();
  }

  async upsertQuantity(customerId, menuItemId, vendorId, quantity) {
    const doc = await CartItem.findOneAndUpdate(
      { customer_id: customerId, menu_item_id: menuItemId },
      {
        $set: { vendor_id: vendorId },
        $inc: { quantity: quantity },
        $setOnInsert: { customer_id: customerId, menu_item_id: menuItemId },
      },
      { new: true, upsert: true }
    );
    return doc;
  }

  async setQuantity(customerId, menuItemId, quantity) {
    return CartItem.findOneAndUpdate(
      { customer_id: customerId, menu_item_id: menuItemId },
      { $set: { quantity } },
      { new: true }
    ).lean();
  }

  async removeItem(customerId, menuItemId) {
    const result = await CartItem.deleteOne({
      customer_id: customerId,
      menu_item_id: menuItemId,
    });
    return result.deletedCount > 0;
  }

  async clear(customerId) {
    const result = await CartItem.deleteMany({ customer_id: customerId });
    return result.deletedCount;
  }
}

module.exports = new CartRepository();

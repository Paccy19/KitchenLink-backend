const { MenuItemOption } = require('../models');

class MenuItemOptionRepository {
  async findByMenuItemIds(menuItemIds) {
    return MenuItemOption.find({
      menu_item_id: { $in: menuItemIds },
      deleted_at: null,
    })
      .sort({ sort_order: 1, name: 1 })
      .lean();
  }

  async findByMenuItem(menuItemId) {
    return MenuItemOption.find({ menu_item_id: menuItemId, deleted_at: null })
      .sort({ sort_order: 1, name: 1 })
      .lean();
  }

  async createMany(vendorId, menuItemId, options) {
    if (!options || options.length === 0) return [];
    const docs = options.map((option, index) => ({
      menu_item_id: menuItemId,
      vendor_id: vendorId,
      group_name: option.group_name,
      name: option.name,
      additional_price_rwf: option.additional_price_rwf,
      is_available: option.is_available,
      sort_order: option.sort_order ?? index,
    }));
    const created = await MenuItemOption.insertMany(docs);
    return created.map((doc) => doc.toObject());
  }

  /** Full replacement used by menu item updates. */
  async replaceForItem(vendorId, menuItemId, options) {
    await MenuItemOption.deleteMany({ menu_item_id: menuItemId, vendor_id: vendorId });
    return this.createMany(vendorId, menuItemId, options);
  }

  async deleteByMenuItem(menuItemId) {
    await MenuItemOption.deleteMany({ menu_item_id: menuItemId });
  }
}

module.exports = new MenuItemOptionRepository();

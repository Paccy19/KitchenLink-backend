const mongoose = require('mongoose');
const { MenuItem } = require('../models');
const { buildTokenFilter } = require('../utils/search');

class MenuItemRepository {
  async findById(menuItemId) {
    return MenuItem.findById(menuItemId).lean();
  }

  async findAvailableById(menuItemId) {
    return MenuItem.findOne({ _id: menuItemId, is_available: true }).lean();
  }

  /**
   * Most frequently ordered, available dishes, optionally restricted
   * to a set of nearby vendors. Returns vendor info for display.
   */
  async findPopular({ vendorIds = null, limit }) {
    const match = { is_available: true };
    if (vendorIds && vendorIds.length > 0) match.vendor_id = { $in: vendorIds };

    return MenuItem.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'vendors',
          localField: 'vendor_id',
          foreignField: '_id',
          as: 'vendor',
        },
      },
      { $unwind: '$vendor' },
      { $match: { 'vendor.is_active': true } },
      { $sort: { orders_count: -1, 'vendor.rating': -1, name: 1 } },
      { $limit: limit },
    ]);
  }

  async findByVendor(vendorId) {
    return MenuItem.find({ vendor_id: vendorId, is_available: true })
      .populate('category_id', 'name icon_url sort_order')
      .lean();
  }

  /** Vendor ids that sell at least one available dish in the category. */
  async findVendorIdsByCategory(categoryId) {
    const ids = await MenuItem.distinct('vendor_id', {
      category_id: categoryId,
      is_available: true,
    });
    return ids.map((id) => new mongoose.Types.ObjectId(String(id)));
  }

  /**
   * Fuzzy search across dish, vendor and category names.
   * Returns a capped candidate set for service-level relevance ranking.
   */
  async search({ tokens, limit }) {
    const tokenFilter = buildTokenFilter(tokens, [
      'name',
      'vendor.name',
      'category.name',
    ]);

    return MenuItem.aggregate([
      {
        $lookup: {
          from: 'vendors',
          localField: 'vendor_id',
          foreignField: '_id',
          as: 'vendor',
        },
      },
      { $unwind: '$vendor' },
      { $match: { 'vendor.is_active': true } },
      {
        $lookup: {
          from: 'categories',
          localField: 'category_id',
          foreignField: '_id',
          as: 'category',
        },
      },
      { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
      { $match: tokenFilter },
      { $sort: { orders_count: -1, 'vendor.rating': -1 } },
      { $limit: limit },
    ]);
  }
}

module.exports = new MenuItemRepository();

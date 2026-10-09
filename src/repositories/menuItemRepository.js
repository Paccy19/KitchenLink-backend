const mongoose = require('mongoose');
const { MenuItem } = require('../models');
const { buildTokenFilter } = require('../utils/search');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class MenuItemRepository {
  async findById(menuItemId) {
    return MenuItem.findById(menuItemId).lean();
  }

  async findAvailableById(menuItemId) {
    return MenuItem.findOne({
      _id: menuItemId,
      is_available: true,
      deleted_at: null,
    }).lean();
  }

  /** Vendor-scoped lookup (includes unavailable items, excludes deleted). */
  async findByIdForVendor(menuItemId, vendorId) {
    return MenuItem.findOne({
      _id: menuItemId,
      vendor_id: vendorId,
      deleted_at: null,
    })
      .populate('category_id', 'name icon_url sort_order')
      .lean();
  }

  /**
   * Most frequently ordered, available dishes, optionally restricted
   * to a set of nearby vendors. Returns vendor info for display.
   */
  async findPopular({ vendorIds = null, limit }) {
    const match = { is_available: true, deleted_at: null };
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
    return MenuItem.find({
      vendor_id: vendorId,
      is_available: true,
      deleted_at: null,
    })
      .populate('category_id', 'name icon_url sort_order')
      .lean();
  }

  /** Vendor Dashboard listing with filtering, sorting and pagination. */
  async listByVendor(vendorId, { categoryId, isAvailable, q, sort, limit, offset }) {
    const filter = { vendor_id: vendorId, deleted_at: null };
    if (categoryId) filter.category_id = categoryId;
    if (typeof isAvailable === 'boolean') filter.is_available = isAvailable;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { description: rx }];
    }

    const sortSpec =
      {
        name: { name: 1 },
        price_asc: { price_rwf: 1, name: 1 },
        price_desc: { price_rwf: -1, name: 1 },
        oldest: { created_at: 1 },
      }[sort] || { created_at: -1 };

    const [items, total] = await Promise.all([
      MenuItem.find(filter)
        .populate('category_id', 'name icon_url sort_order')
        .sort(sortSpec)
        .skip(offset)
        .limit(limit)
        .lean(),
      MenuItem.countDocuments(filter),
    ]);

    return { items, total };
  }

  async create(doc) {
    const item = await MenuItem.create(doc);
    return item.toObject();
  }

  async update(menuItemId, vendorId, update) {
    return MenuItem.findOneAndUpdate(
      { _id: menuItemId, vendor_id: vendorId, deleted_at: null },
      { $set: update },
      { new: true }
    ).lean();
  }

  async setAvailability(menuItemId, vendorId, isAvailable) {
    return MenuItem.findOneAndUpdate(
      { _id: menuItemId, vendor_id: vendorId, deleted_at: null },
      { $set: { is_available: isAvailable } },
      { new: true }
    ).lean();
  }

  async softDelete(menuItemId, vendorId) {
    return MenuItem.findOneAndUpdate(
      { _id: menuItemId, vendor_id: vendorId, deleted_at: null },
      { $set: { deleted_at: new Date(), is_available: false } },
      { new: true }
    ).lean();
  }

  async hardDelete(menuItemId, vendorId) {
    return MenuItem.findOneAndDelete({ _id: menuItemId, vendor_id: vendorId }).lean();
  }

  async incrementOrdersCount(menuItemId, by = 1) {
    await MenuItem.updateOne(
      { _id: menuItemId },
      { $inc: { orders_count: by } }
    );
  }

  /** Vendor ids that sell at least one available dish in the category. */
  async findVendorIdsByCategory(categoryId) {
    const ids = await MenuItem.distinct('vendor_id', {
      category_id: categoryId,
      is_available: true,
      deleted_at: null,
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
      { $match: { ...tokenFilter, deleted_at: null } },
      { $sort: { orders_count: -1, 'vendor.rating': -1 } },
      { $limit: limit },
    ]);
  }
}

module.exports = new MenuItemRepository();

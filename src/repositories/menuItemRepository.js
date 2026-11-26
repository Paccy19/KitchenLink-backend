const mongoose = require('mongoose');
const { MenuItem, MenuItemOption } = require('../models');
const { buildTokenFilter } = require('../utils/search');
const { liveVendorFilter } = require('../utils/vendorPresence');

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

  /** Categories with at least one available item from an active, live vendor. */
  async findCategoryIdsWithAvailableItems() {
    const categories = await MenuItem.aggregate([
      {
        $match: {
          category_id: { $ne: null },
          is_available: true,
          deleted_at: null,
        },
      },
      {
        $lookup: {
          from: 'vendors',
          localField: 'vendor_id',
          foreignField: '_id',
          as: 'vendor',
        },
      },
      { $unwind: '$vendor' },
      {
        $match: {
          'vendor.is_active': true,
          'vendor.deleted_at': null,
          ...liveVendorFilter('vendor'),
        },
      },
      { $group: { _id: '$category_id' } },
    ]);

    return categories.map(({ _id }) => String(_id));
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
      { $match: { 'vendor.is_active': true, ...liveVendorFilter('vendor') } },
      { $sort: { orders_count: -1, 'vendor.rating': -1, name: 1 } },
      { $limit: limit },
    ]);
  }

  /**
   * Every available dish from active kitchens (open or closed), one page at a
   * time, for the customer "All Dishes" list. `sort`: recommended (open
   * kitchens first, then most ordered), price_asc, price_desc, rating
   * (kitchen rating) or delivery_time (preparation time).
   */
  async listForCustomers({ categoryId = null, sort = 'recommended', limit, offset }) {
    const match = { is_available: true, deleted_at: null };
    if (categoryId) match.category_id = new mongoose.Types.ObjectId(String(categoryId));

    const sortSpec =
      {
        price_asc: { price_rwf: 1, orders_count: -1, _id: 1 },
        price_desc: { price_rwf: -1, orders_count: -1, _id: 1 },
        rating: { 'vendor.rating': -1, orders_count: -1, _id: 1 },
        delivery_time: { prep_minutes: 1, orders_count: -1, _id: 1 },
      }[sort] || { open_rank: -1, orders_count: -1, 'vendor.rating': -1, name: 1, _id: 1 };

    const [result] = await MenuItem.aggregate([
      { $match: match },
      { $lookup: { from: 'vendors', localField: 'vendor_id', foreignField: '_id', as: 'vendor' } },
      { $unwind: '$vendor' },
      { $match: { 'vendor.is_active': true, 'vendor.deleted_at': null } },
      {
        $addFields: {
          open_rank: { $cond: [{ $eq: ['$vendor.is_open', false] }, 0, 1] },
          prep_minutes: {
            $cond: [
              { $gt: ['$preparation_time_minutes', 0] },
              '$preparation_time_minutes',
              { $ifNull: ['$vendor.estimated_prep_time', 30] },
            ],
          },
        },
      },
      {
        $facet: {
          items: [
            { $sort: sortSpec },
            { $skip: offset },
            { $limit: limit },
            { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'category' } },
            { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
            // Dishes with options open their details instead of a one-tap add.
            {
              $lookup: {
                from: MenuItemOption.collection.name,
                let: { itemId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$menu_item_id', '$$itemId'] },
                      deleted_at: null,
                      is_available: { $ne: false },
                    },
                  },
                  { $limit: 1 },
                  { $project: { _id: 1 } },
                ],
                as: 'option_probe',
              },
            },
            { $addFields: { has_options: { $gt: [{ $size: '$option_probe' }, 0] } } },
            { $project: { option_probe: 0 } },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    return { items: result?.items ?? [], total: result?.total?.[0]?.count ?? 0 };
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
  async listByVendor(vendorId, { categoryId, isAvailable, q, sort, limit, offset, departmentFilter = {} }) {
    const filter = { vendor_id: vendorId, deleted_at: null, ...departmentFilter };
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
      { returnDocument: 'after' }
    ).lean();
  }

  async setAvailability(menuItemId, vendorId, isAvailable) {
    return MenuItem.findOneAndUpdate(
      { _id: menuItemId, vendor_id: vendorId, deleted_at: null },
      { $set: { is_available: isAvailable } },
      { returnDocument: 'after' }
    ).lean();
  }

  async softDelete(menuItemId, vendorId) {
    return MenuItem.findOneAndUpdate(
      { _id: menuItemId, vendor_id: vendorId, deleted_at: null },
      { $set: { deleted_at: new Date(), is_available: false } },
      { returnDocument: 'after' }
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
      { $match: { 'vendor.is_active': true, ...liveVendorFilter('vendor') } },
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

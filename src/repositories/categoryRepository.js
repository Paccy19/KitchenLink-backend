const { Category } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CategoryRepository {
  async findAll(limit = 100) {
    return Category.find()
      .sort({ sort_order: 1, name: 1 })
      .limit(limit)
      .lean();
  }

  /** Active categories only — used by the customer app. */
  async findAllActive(limit = 100) {
    return Category.find({ is_active: { $ne: false } })
      .sort({ sort_order: 1, name: 1 })
      .limit(limit)
      .lean();
  }

  async findById(categoryId) {
    return Category.findById(categoryId).lean();
  }

  async findByName(name) {
    return Category.findOne({
      name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    }).lean();
  }

  /* ------------------------------- admin ------------------------------- */

  async create(doc) {
    const category = await Category.create(doc);
    return category.toObject();
  }

  async update(categoryId, update) {
    return Category.findOneAndUpdate(
      { _id: categoryId },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async remove(categoryId) {
    return Category.findByIdAndDelete(categoryId).lean();
  }

  async countVendorsUsing(categoryId) {
    const { Vendor } = require('../models');
    return Vendor.countDocuments({
      deleted_at: null,
      $or: [{ food_category_ids: categoryId }, { food_categories: categoryId }],
    });
  }
}

module.exports = new CategoryRepository();

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

  async findById(categoryId) {
    return Category.findById(categoryId).lean();
  }

  async findByName(name) {
    return Category.findOne({
      name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    }).lean();
  }
}

module.exports = new CategoryRepository();

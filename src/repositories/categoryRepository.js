const { Category } = require('../models');

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
}

module.exports = new CategoryRepository();

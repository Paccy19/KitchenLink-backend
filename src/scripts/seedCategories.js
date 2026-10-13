/* eslint-disable no-console */
/**
 * Sets the food categories to the official list, in this order.
 * Any other category is deleted, or hidden (is_active: false) if a vendor,
 * menu item or commission still uses it.
 *
 * Usage: npm run seed:categories   (idempotent)
 */
const mongoose = require('mongoose');
const config = require('../config');
const { Category, MenuItem, Vendor, Commission } = require('../models');

const FOOD_CATEGORIES = [
  'Local Food',
  'Fast Food',
  'African Food',
  'Healthy Food',
  'Bakery',
  'Breakfast',
  'Lunch',
  'Dinner',
  'Drinks',
  'Desserts',
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const run = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);

  const keepIds = [];
  for (const [index, name] of FOOD_CATEGORIES.entries()) {
    const existing = await Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
    const category = existing || new Category({ name });
    category.name = name;
    category.sort_order = index + 1;
    category.is_active = true;
    await category.save();
    keepIds.push(category._id);
    console.log(`${existing ? 'Kept   ' : 'Created'} ${name}`);
  }

  const others = await Category.find({ _id: { $nin: keepIds } });
  for (const category of others) {
    const inUse =
      (await MenuItem.exists({ category_id: category._id })) ||
      (await Vendor.exists({ food_category_ids: category._id })) ||
      (await Commission.exists({ category_id: category._id, deleted_at: null }));
    if (inUse) {
      category.is_active = false;
      await category.save();
      console.log(`Hidden  ${category.name} (still used)`);
    } else {
      await category.deleteOne();
      console.log(`Removed ${category.name}`);
    }
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});

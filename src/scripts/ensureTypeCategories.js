/* eslint-disable no-console */
/**
 * Makes sure every vendor type's default food categories exist (the
 * categories kitchens get automatically, config/vendorTypes.js
 * DEFAULT_FOOD_CATEGORIES — e.g. Breads, Pastries, Cakes and Cookies for
 * Bakery). Unlike `npm run seed:categories` it never deletes, hides or
 * reorders anything:
 *  - a missing category is created (active, placed after the existing ones),
 *    tagged with the vendor types it is a default for;
 *  - an existing equivalent (alias, e.g. Drinks for Beverages) is reused as it
 *    is, never duplicated or re-tagged;
 *  - an existing one that has never been tagged gets its vendor types;
 *  - anything an admin already changed (tags, name case, hidden) is left alone.
 *
 * Runs at every server start, so a fresh database or a teammate's local one
 * gets the categories without extra steps. Also: npm run seed:type-categories
 */
const { Category } = require('../models');
const {
  DEFAULT_FOOD_CATEGORIES,
  DEFAULT_CATEGORY_ALIASES,
  DEFAULT_CATEGORY_DESCRIPTIONS,
} = require('../config/vendorTypes');

/** One entry per default category name, with the vendor types it belongs to. */
const TYPE_CATEGORIES = (() => {
  const byName = new Map();
  for (const [code, names] of Object.entries(DEFAULT_FOOD_CATEGORIES)) {
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, { name, vendor_types: [], description: DEFAULT_CATEGORY_DESCRIPTIONS[name] || '' });
      byName.get(name).vendor_types.push(code);
    }
  }
  return [...byName.values()];
})();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byExactName = (name) => Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }).lean();

/** Returns { created, tagged, reused }: the names it created / tagged / reused as an equivalent. */
async function ensureTypeCategories({ log = () => {} } = {}) {
  const created = [];
  const tagged = [];
  const reused = [];
  for (const entry of TYPE_CATEGORIES) {
    const existing = await byExactName(entry.name);
    if (!existing) {
      let equivalent = null;
      for (const alias of DEFAULT_CATEGORY_ALIASES[entry.name] || []) {
        equivalent = await byExactName(alias);
        if (equivalent) break;
      }
      if (equivalent) {
        reused.push(`${entry.name} → ${equivalent.name}`);
        log(`Reused  ${equivalent.name} for ${entry.name}`);
        continue;
      }
    }
    if (!existing) {
      const last = await Category.findOne().sort({ sort_order: -1 }).select('sort_order').lean();
      await Category.create({ ...entry, sort_order: (last?.sort_order ?? 0) + 1, is_active: true });
      created.push(entry.name);
      log(`Created ${entry.name} (${entry.vendor_types.join(', ')})`);
    } else if (existing.vendor_types === undefined) {
      // Saved before categories had vendor types: tag it once. An empty list
      // set by an admin means "general" and is respected.
      await Category.updateOne({ _id: existing._id }, { $set: { vendor_types: entry.vendor_types } });
      tagged.push(existing.name);
      log(`Tagged  ${existing.name} (${entry.vendor_types.join(', ')})`);
    } else {
      log(`Kept    ${existing.name}`);
    }
  }
  return { created, tagged, reused };
}

module.exports = ensureTypeCategories;
module.exports.TYPE_CATEGORIES = TYPE_CATEGORIES;

if (require.main === module) {
  const mongoose = require('mongoose');
  const config = require('../config');
  (async () => {
    await mongoose.connect(config.mongoUri);
    console.log(`Connected to ${config.mongoUri}`);
    await ensureTypeCategories({ log: console.log });
    await mongoose.disconnect();
  })().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
  });
}

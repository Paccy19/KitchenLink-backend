/* eslint-disable no-console */
/**
 * Makes sure the categories meant for a specific vendor type exist (e.g.
 * Breads, Pastries, Cakes and Cookies for Bakery kitchens). Unlike
 * `npm run seed:categories` it never deletes, hides or reorders anything:
 *  - a missing category is created (active, placed after the existing ones);
 *  - an existing one that has never been tagged gets its vendor types;
 *  - anything an admin already changed (tags, name case, hidden) is left alone.
 *
 * Runs at every server start, so a fresh database or a teammate's local one
 * gets the categories without extra steps. Also: npm run seed:type-categories
 */
const { Category } = require('../models');

const TYPE_CATEGORIES = [
  { name: 'Breads', vendor_types: ['bakery'], description: 'Loaves, rolls, baguettes and other breads.' },
  { name: 'Pastries', vendor_types: ['bakery'], description: 'Croissants, puff pastries, samosas and more.' },
  { name: 'Cakes', vendor_types: ['bakery'], description: 'Birthday, wedding and sponge cakes.' },
  { name: 'Cookies', vendor_types: ['bakery'], description: 'Cookies and biscuits.' },
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns { created, tagged }: the names it created / tagged. */
async function ensureTypeCategories({ log = () => {} } = {}) {
  const created = [];
  const tagged = [];
  for (const entry of TYPE_CATEGORIES) {
    const existing = await Category.findOne({ name: new RegExp(`^${escapeRegex(entry.name)}$`, 'i') }).lean();
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
  return { created, tagged };
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

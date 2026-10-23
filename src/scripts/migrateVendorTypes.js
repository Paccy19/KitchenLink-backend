/**
 * One-off: converts stored vendor types from labels ("Home Cook", "Café",
 * "Bar & Grill", …) to codes (home_cook, cafe, restaurant, …) on vendors and
 * commission rules. Safe to run again: codes are left as they are.
 *
 *   npm run migrate:vendor-types
 */
const mongoose = require('mongoose');
const config = require('../config');
const { toVendorTypeCode } = require('../config/vendorTypes');

async function convert(collection, field) {
  const rows = await collection.find({ [field]: { $type: 'string', $ne: '' } }, { projection: { [field]: 1 } }).toArray();
  let changed = 0;
  for (const row of rows) {
    const code = toVendorTypeCode(row[field]) || 'other';
    if (code === row[field]) continue;
    await collection.updateOne({ _id: row._id }, { $set: { [field]: code } });
    console.log(`  ${collection.collectionName} ${row._id}: "${row[field]}" -> ${code}`);
    changed += 1;
  }
  return changed;
}

(async () => {
  await mongoose.connect(config.mongoUri, { autoIndex: false });
  const db = mongoose.connection.db;
  const vendors = await convert(db.collection('vendors'), 'vendor_type');
  const commissions = await convert(db.collection('commissions'), 'vendor_type');
  await db.collection('vendors').createIndex({ vendor_type: 1, is_active: 1 });
  console.log(`Done: ${vendors} vendor(s) and ${commissions} commission rule(s) converted; vendor_type index ensured.`);
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

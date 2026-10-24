const { toVendorTypeCode } = require('../config/vendorTypes');

/**
 * Converts stored vendor types that aren't current codes (old labels like
 * "Home Cook", or types since removed from config/vendorTypes.js) to codes,
 * mapping anything unknown to 'other', on vendors and commission rules. Safe
 * to run again: current codes are left alone. Runs at every server start and
 * from `npm run migrate:vendor-types`. Returns how many rows changed.
 */
async function normalizeVendorTypes(db, { log = console.log } = {}) {
  let changed = 0;
  for (const name of ['vendors', 'commissions']) {
    const collection = db.collection(name);
    const rows = await collection
      .find({ vendor_type: { $type: 'string', $ne: '' } }, { projection: { vendor_type: 1 } })
      .toArray();
    for (const row of rows) {
      const code = toVendorTypeCode(row.vendor_type) || 'other';
      if (code === row.vendor_type) continue;
      await collection.updateOne({ _id: row._id }, { $set: { vendor_type: code } });
      log(`  ${name} ${row._id}: vendor type "${row.vendor_type}" -> ${code}`);
      changed += 1;
    }
  }
  return changed;
}

module.exports = normalizeVendorTypes;

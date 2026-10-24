/**
 * Converts stored vendor types from labels ("Home Cook", "Café", …) or types
 * no longer in config/vendorTypes.js to codes (unknown -> other), on vendors
 * and commission rules. The server also does this at every start; this script
 * is for running it by hand. Safe to run again.
 *
 *   npm run migrate:vendor-types
 */
const mongoose = require('mongoose');
const config = require('../config');
const normalizeVendorTypes = require('./normalizeVendorTypes');

(async () => {
  await mongoose.connect(config.mongoUri, { autoIndex: false });
  const db = mongoose.connection.db;
  const changed = await normalizeVendorTypes(db);
  await db.collection('vendors').createIndex({ vendor_type: 1, is_active: 1 });
  console.log(`Done: ${changed} vendor type(s) converted; vendor_type index ensured.`);
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

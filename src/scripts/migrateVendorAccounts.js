/* eslint-disable no-console */
/**
 * Backfills the Vendor collection for the Vendor Dashboard feature:
 *   - email + temporary password for vendors created before login existed
 *   - wallet fields (available_balance, total_sales) where missing
 *   - deleted_at marker where missing
 *
 * Existing credentials are never overwritten. Usage: npm run migrate:vendors
 */
const mongoose = require('mongoose');
const config = require('../config');
const { hashPassword } = require('../utils/password');

const TEMP_PASSWORD = 'ChangeMe123!';

const slug = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'vendor';

const run = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);

  const vendors = await mongoose.connection
    .collection('vendors')
    .find({})
    .toArray();

  let updated = 0;
  let createdCredentials = 0;

  for (const vendor of vendors) {
    const set = {};

    if (!vendor.email) {
      set.email = `${slug(vendor.name)}-${String(vendor._id).slice(-6)}@vendor.ofk.rw`;
    }
    if (vendor.available_balance === undefined || vendor.available_balance === null) {
      set.available_balance = 0;
    }
    if (vendor.total_sales === undefined || vendor.total_sales === null) {
      set.total_sales = 0;
    }
    if (vendor.deleted_at === undefined) {
      set.deleted_at = null;
    }
    if (!vendor.password_hash) {
      set.password_hash = await hashPassword(TEMP_PASSWORD);
      createdCredentials += 1;
    }

    if (Object.keys(set).length > 0) {
      await mongoose.connection
        .collection('vendors')
        .updateOne({ _id: vendor._id }, { $set: set });
      updated += 1;
    }
  }

  console.log(`Scanned ${vendors.length} vendors, updated ${updated}.`);
  if (createdCredentials > 0) {
    console.log(
      `Issued ${createdCredentials} temporary passwords ("${TEMP_PASSWORD}") — rotate after first login.`
    );
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Migration failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

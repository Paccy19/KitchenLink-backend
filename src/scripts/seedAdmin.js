/* eslint-disable no-console */
/**
 * Seeds the super-admin account and a default global commission config so the
 * Admin Panel is usable on a fresh database.
 *
 * Usage: npm run seed:admin   (idempotent — never overwrites existing rows)
 */
const mongoose = require('mongoose');
const config = require('../config');
const adminAuthService = require('../services/adminAuthService');
const commissionRepository = require('../repositories/commissionRepository');

const run = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);

  const admin = await adminAuthService.ensureSeedAdmin();
  console.log(
    admin.created
      ? `Created admin ${config.admin.seedEmail}`
      : `Admin ${config.admin.seedEmail} already exists`
  );

  const globalCommission = await commissionRepository.findGlobal();
  if (globalCommission) {
    console.log('Global commission config already exists');
  } else {
    await commissionRepository.create({
      name: 'Default platform commission',
      scope: 'global',
      percentage: config.admin.commissionDefaultPercent,
      fixed_fee_rwf: 0,
      is_active: true,
    });
    console.log(
      `Created global commission config (${config.admin.commissionDefaultPercent}%)`
    );
  }

  console.log(`\nAdmin login: ${config.admin.seedEmail} / ${config.admin.seedPassword}`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

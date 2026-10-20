/* eslint-disable no-console */
/**
 * Seeds the PostgreSQL mirror so it matches a freshly seeded MongoDB.
 *
 * Phase 1 seeds MongoDB through the application's own logic (identical to
 * npm run seed:admin + seed:categories + seed:drivers):
 *   - super-admin account and global commission config
 *   - the 10 official food categories, in order
 *   - 4 demo delivery workers (OTP login)
 *
 * Phase 2 mirrors the four affected tables (admins, commissions, categories,
 * drivers) into PostgreSQL with identical _id values, so MongoDB remains the
 * source of truth and PostgreSQL stays a byte-identical copy. Existing PG rows
 * are upserted; rows deleted in MongoDB are deleted in PostgreSQL.
 *
 * Prerequisite: npm run migrate:pg   (creates tables and copies all data)
 * Usage: npm run seed:pg   (idempotent — safe to re-run)
 */
const mongoose = require('mongoose');
const config = require('../config');
const adminAuthService = require('../services/adminAuthService');
const commissionRepository = require('../repositories/commissionRepository');
const { Category, MenuItem, Vendor, Commission } = require('../models');
const { normalizePhone } = require('../utils/validators');
const { pool } = require('../db/postgres');
const { SPECS, toRowValues } = require('./migratePostgres');

const SEED_TABLES = ['admins', 'commissions', 'categories', 'drivers'];

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

const DEMO_DRIVERS = [
  { name: 'Eric Uwimana', phone: '0788100001', vehicle_type: 'motorcycle', plate_number: 'RAD 101 A', latitude: -1.9441, longitude: 30.0619 },
  { name: 'Aline Mukamana', phone: '0788100002', vehicle_type: 'motorcycle', plate_number: 'RAD 102 B', latitude: -1.9536, longitude: 30.1135 },
  { name: 'Jean Bosco', phone: '0788100003', vehicle_type: 'car', plate_number: 'RAC 103 C', latitude: -1.9484, longitude: 30.0724 },
  { name: 'Grace Ingabire', phone: '0788100004', vehicle_type: 'scooter', plate_number: 'RAD 104 D', latitude: -1.9356, longitude: 30.0793 },
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const seedMongo = async () => {
  console.log('\n--- Phase 1: seeding MongoDB (admin, commission, categories, drivers) ---');

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
    console.log(`Created global commission config (${config.admin.commissionDefaultPercent}%)`);
  }

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

  const driverCollection = mongoose.connection.collection('drivers');
  let created = 0;
  for (const driver of DEMO_DRIVERS) {
    const phone = normalizePhone(driver.phone);
    const existing = await driverCollection.findOne({ phone });
    if (existing) {
      console.log(`Skip ${phone} (already registered)`);
      continue;
    }
    await driverCollection.insertOne({
      name: driver.name,
      phone,
      vehicle_type: driver.vehicle_type,
      plate_number: driver.plate_number,
      location: {
        type: 'Point',
        coordinates: [driver.longitude, driver.latitude],
      },
      is_online: false,
      is_available: false,
      status: 'offline',
      active_deliveries_count: 0,
      max_active_deliveries: config.delivery.maxActiveDeliveries,
      rating: 5,
      rating_count: 0,
      completed_deliveries: 0,
      total_earnings_rwf: 0,
      verification_status: 'approved',
      is_active: true,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    created += 1;
    console.log(`Created delivery worker ${driver.name} (${phone})`);
  }
  console.log(`Seeded ${created} new delivery worker(s).`);
};

const mirrorTable = async (spec) => {
  const docs = await mongoose.connection.db.collection(spec.collection).find({}).toArray();
  const ids = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same load technique as migratePostgres.js: mirror exactly, even if the
    // source data (or a stale PG copy) contains dangling references.
    await client.query('SET LOCAL session_replication_role = replica');
    for (const doc of docs) {
      const values = toRowValues(spec, doc);
      const columns = Object.keys(values);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const updates = columns
        .filter((c) => c !== '_id')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      await client.query(
        `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (_id) DO UPDATE SET ${updates || '_id = excluded._id'}`,
        columns.map((c) => values[c])
      );
      ids.push(String(doc._id));
    }
    if (ids.length) {
      await client.query(`DELETE FROM ${spec.table} WHERE _id::text <> ALL($1::text[])`, [ids]);
    } else {
      await client.query(`DELETE FROM ${spec.table}`);
    }
    await client.query('SET LOCAL session_replication_role = origin');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  console.log(`${spec.table}: ${docs.length} row(s) mirrored`);
  return docs;
};

const verify = async (specs, seeded) => {
  console.log('\nVerifying MongoDB <-> PostgreSQL parity for seeded tables ...');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('TABLE', 24)}${pad('MONGO', 8)}${pad('POSTGRES', 10)}${pad('IDS', 6)}RESULT`);
  let allPassed = true;
  const failures = [];
  for (const spec of specs) {
    const docs = seeded.get(spec.table);
    const pgCount = (await pool.query(`SELECT count(*)::int AS c FROM ${spec.table}`)).rows[0].c;
    const pgIds = new Set(
      (await pool.query(`SELECT _id FROM ${spec.table}`)).rows.map((r) => r._id)
    );
    const missing = docs.filter((d) => !pgIds.has(String(d._id)));
    const idsOk = missing.length === 0 && pgCount === docs.length;
    for (const d of missing) failures.push(`${spec.table}: _id ${d._id} missing in PostgreSQL`);
    if (pgCount !== docs.length) {
      failures.push(`${spec.table}: count mongo=${docs.length} pg=${pgCount}`);
    }
    if (!idsOk) allPassed = false;
    console.log(
      `${pad(spec.table, 24)}${pad(docs.length, 8)}${pad(pgCount, 10)}${pad(idsOk ? 'ok' : 'FAIL', 6)}${idsOk ? 'PASS' : 'FAIL'}`
    );
  }
  if (!allPassed) {
    console.log('VERIFICATION FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return allPassed;
};

const run = async () => {
  const started = Date.now();
  console.log(`MongoDB source : ${config.mongoUri}`);
  console.log(
    `PostgreSQL tgt : ${(process.env.PG_URI || '').replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}`
  );

  const probe = await pool.query(`SELECT to_regclass('admins') AS t`);
  if (!probe.rows[0].t) {
    console.error('PostgreSQL tables not found — run `npm run migrate:pg` first, then seed.');
    await pool.end();
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  await seedMongo();

  console.log('\n--- Phase 2: mirroring seed tables into PostgreSQL ---');
  const specs = SEED_TABLES.map((table) => SPECS.find((s) => s.table === table));
  const seeded = new Map();
  for (const spec of specs) {
    seeded.set(spec.table, await mirrorTable(spec));
  }

  const ok = await verify(specs, seeded);
  if (ok) {
    console.log(`ALL CHECKS PASSED — seed mirrored in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    console.log(`Admin login: ${config.admin.seedEmail} / ${config.admin.seedPassword}`);
  } else {
    process.exitCode = 1;
  }

  await mongoose.disconnect();
  await pool.end();
};

run().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});

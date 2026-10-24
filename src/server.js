const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const { connectPostgres, closePostgres, maskUri } = require('./db/postgres');
const adminAuthService = require('./services/adminAuthService');
const commissionRepository = require('./repositories/commissionRepository');
const driverRepository = require('./repositories/driverRepository');
const platformLedgerService = require('./services/platformLedgerService');
const platformSweepService = require('./services/platformSweepService');
const vendorOfferService = require('./services/vendorOfferService');
const deliveryService = require('./services/deliveryService');
const deliverySettingsService = require('./services/deliverySettingsService');
const bankSettingsService = require('./services/bankSettingsService');
const deliveryFeeSettingsService = require('./services/deliveryFeeSettingsService');
const dispatchSettingsService = require('./services/dispatchSettingsService');
const privateDocumentsService = require('./services/privateDocumentsService');


const bootstrapAdmin = async () => {
  try {
    const seed = await adminAuthService.ensureSeedAdmin();
    if (seed.created) {
      console.log(
        `Seeded admin account: ${config.admin.seedEmail} (change the password after first login)`
      );
    }
    const globalCommission = await commissionRepository.findGlobal();
    if (!globalCommission) {
      await commissionRepository.create({
        name: 'Default platform commission',
        scope: 'global',
        percentage: config.admin.commissionDefaultPercent,
        fixed_fee_rwf: 0,
        is_active: true,
      });
      console.log(
        `Seeded default global commission (${config.admin.commissionDefaultPercent}%)`
      );
    } else if (
      globalCommission.name === 'Default platform commission' &&
      globalCommission.fixed_fee_rwf === 0 &&
      globalCommission.percentage !== config.admin.commissionDefaultPercent &&
      globalCommission.percentage === 0
    ) {
      // Upgrade the untouched legacy default (0%) to the configured rate.
      await commissionRepository.update(globalCommission._id, {
        percentage: config.admin.commissionDefaultPercent,
      });
      console.log(
        `Updated default global commission to ${config.admin.commissionDefaultPercent}%`
      );
    }
  } catch (error) {
    if (error.code === 'SEED_PASSWORD_REQUIRED') {
      console.error(`Refusing to start: ${error.message}`);
      process.exit(1);
    }
    console.error('Admin bootstrap failed:', error);
  }

  try {
    const backfilled = await driverRepository.backfillAvailableBalances();
    if (backfilled > 0) {
      console.log(`Opened withdrawable balances for ${backfilled} existing delivery worker(s)`);
    }
  } catch (error) {
    console.error('Delivery worker balance backfill failed:', error);
  }

  try {
    const { renamed, backfilled } = await platformLedgerService.migrateLegacyLedger();
    if (renamed > 0) console.log(`Upgraded ${renamed} ledger entries to owed-money accounting`);
    if (backfilled > 0) console.log(`Recorded ${backfilled} past customer payment(s) missing from the ledger`);
    const books = await platformLedgerService.snapshot();
    if (books.unreconciled_rwf !== 0) {
      console.warn(
        `[ledger] Books do not balance: ${books.unreconciled_rwf} RWF unaccounted for (see /admin/platform/wallet)`
      );
    }
  } catch (error) {
    console.error('Ledger check failed:', error);
  }
};

const start = async () => {
  // Signed sessions are only as safe as this secret. A weak one is only
  // allowed when .env explicitly says this is a development or test server, so
  // a live server that forgot NODE_ENV can't run with a public secret.
  const secretProblem = config.auth.jwtSecretProblem;
  if (secretProblem) {
    const fix = `set JWT_SECRET to a random string of at least ${config.auth.jwtSecretMinLength} characters`;
    if (!config.explicitDev) {
      console.error(`Refusing to start: JWT_SECRET is ${secretProblem}; ${fix}.`);
      process.exit(1);
    }
    console.warn(`[security] JWT_SECRET is ${secretProblem}. Fine for local development; ${fix} before going live.`);
  }

  // Databases without a password are open to anyone who can reach them.
  if (config.databaseProblems.length) {
    if (!config.explicitDev) {
      console.error(`Refusing to start: ${config.databaseProblems.join('; ')}.`);
      process.exit(1);
    }
    console.warn(`[security] ${config.databaseProblems.join('; ')}. Fine for local development; use password-protected databases before going live.`);
  }

  try {
    await mongoose.connect(config.mongoUri);
    // Never print the database password.
    console.log(`MongoDB connected: ${maskUri(config.mongoUri)}`);

    // Same-server PostgreSQL mirror: both databases run with this one server.
    await connectPostgres();

    await bootstrapAdmin();

    // Verification documents uploaded before they were private leave the
    // public uploads folder (old links stop working).
    try {
      const moved = await privateDocumentsService.migratePublicDocuments();
      if (moved > 0) console.log(`Moved ${moved} verification document(s) to private storage`);
    } catch (error) {
      console.error('Moving verification documents to private storage failed:', error.message);
    }

    platformSweepService.start();
    vendorOfferService.start();
    // Admin-set delivery timing rules (warning, late charge, reassign).
    await deliverySettingsService.load();
    await bankSettingsService.load();
    await deliveryFeeSettingsService.load();
    // Admin-set dispatch rules (notification radius, re-offer interval...).
    await dispatchSettingsService.load();
    // Re-offers open orders to drivers who came into range and runs the
    // late-pickup clock.
    deliveryService.start();

    app.listen(config.port, () => {
      console.log(`API listening on http://localhost:${config.port}/api/v1`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Close both database connections cleanly on Ctrl+C / container stop.
const shutdown = async (signal) => {
  console.log(`${signal} received, closing database connections...`);
  await closePostgres();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

start();

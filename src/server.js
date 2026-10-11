const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const adminAuthService = require('./services/adminAuthService');
const commissionRepository = require('./repositories/commissionRepository');

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
    }
  } catch (error) {
    console.error('Admin bootstrap failed:', error);
  }
};

const start = async () => {
  try {
    await mongoose.connect(config.mongoUri);
    console.log(`MongoDB connected: ${config.mongoUri}`);

    await bootstrapAdmin();

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

start();

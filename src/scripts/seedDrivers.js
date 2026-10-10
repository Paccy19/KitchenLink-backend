/* eslint-disable no-console */
/**
 * Seeds demo drivers so the Driver Web App can be tested immediately.
 * Drivers authenticate with the OTP flow, so no password is needed.
 *
 * Usage: npm run seed:drivers   (idempotent — never overwrites existing rows)
 */
const mongoose = require('mongoose');
const config = require('../config');
const { normalizePhone } = require('../utils/validators');

const DEMO_DRIVERS = [
  { name: 'Eric Uwimana', phone: '0788100001', vehicle_type: 'motorcycle', plate_number: 'RAD 101 A', latitude: -1.9441, longitude: 30.0619 },
  { name: 'Aline Mukamana', phone: '0788100002', vehicle_type: 'motorcycle', plate_number: 'RAD 102 B', latitude: -1.9536, longitude: 30.1135 },
  { name: 'Jean Bosco', phone: '0788100003', vehicle_type: 'car', plate_number: 'RAC 103 C', latitude: -1.9484, longitude: 30.0724 },
  { name: 'Grace Ingabire', phone: '0788100004', vehicle_type: 'scooter', plate_number: 'RAD 104 D', latitude: -1.9356, longitude: 30.0793 },
];

const run = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);

  const collection = mongoose.connection.collection('drivers');
  let created = 0;

  for (const driver of DEMO_DRIVERS) {
    const phone = normalizePhone(driver.phone);
    const existing = await collection.findOne({ phone });
    if (existing) {
      console.log(`Skip ${phone} (already registered)`);
      continue;
    }
    await collection.insertOne({
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
    console.log(`Created driver ${driver.name} (${phone})`);
  }

  console.log(`Seeded ${created} driver(s). Log in with OTP via the Driver app.`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
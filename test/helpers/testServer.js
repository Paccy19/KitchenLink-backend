// Starts the API against a separate test database for the API tests.
// Required before anything from src/ so these settings win over .env
// (dotenv never overwrites a variable that is already set).
process.env.NODE_ENV = 'test';
// Each test file runs in its own process with its own database (deleted at
// the end), so files can run side by side. TEST_MONGODB_SERVER picks the server.
process.env.MONGODB_URI = `${(process.env.TEST_MONGODB_SERVER || 'mongodb://127.0.0.1:27017').replace(/\/+$/, '')}/kitchenlink_${process.pid}_test`;
// No outside services: straight-line distances, SMS and emails only logged.
process.env.GOOGLE_MAPS_API_KEY = '';
process.env.SMS_ENABLED = 'false';
process.env.EMAIL_PROVIDER = '';
process.env.SMTP_HOST = '';
process.env.PAYOUT_PROVIDER = 'manual';
process.env.API_RATE_MAX_PER_MINUTE = '100000';

const mongoose = require('mongoose');
const config = require('../../src/config');
const app = require('../../src/app');
const { Vendor, MenuItem } = require('../../src/models');
const customerRepository = require('../../src/repositories/customerRepository');
const { signToken } = require('../../src/utils/jwt');
const { normalizePhone } = require('../../src/utils/validators');

// Request logs and dev codes would drown the test report (TEST_VERBOSE=1 shows them).
if (!process.env.TEST_VERBOSE) console.log = () => {};

let server;
let baseUrl;

/** Connects to the test database (emptied first) and starts the API on a free port. */
async function start() {
  await mongoose.connect(config.mongoUri);
  // Never empty a real database by mistake.
  if (!mongoose.connection.name.endsWith('_test')) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests on "${mongoose.connection.name}": the database name must end in _test.`);
  }
  // Index builds start on connect: let them finish so they can't recreate
  // collections after the database is deleted, then rebuild them (unique
  // indexes are part of the behaviour under test).
  const models = Object.values(mongoose.connection.models);
  await Promise.all(models.map((model) => model.init()));
  await mongoose.connection.dropDatabase();
  await Promise.all(models.map((model) => model.createIndexes()));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
}

async function stop() {
  // Let background work (notifications, driver offers) finish first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

/** Calls the API; returns { status, body }. */
async function api(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let phoneCounter = 0;
const nextPhone = () => {
  phoneCounter += 1;
  return `078${String(process.pid % 10000).padStart(4, '0')}${String(phoneCounter).padStart(3, '0')}`;
};

/**
 * A new customer signed in with an SMS code; returns { token, customer, phone }.
 * Sign-in allows 20 requests a minute, so only the sign-in tests use this.
 */
async function signInCustomer(name = 'Test Customer') {
  const phone = nextPhone();
  const sent = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name } });
  if (sent.status !== 200) throw new Error(`send-otp failed: ${JSON.stringify(sent.body)}`);
  const verified = await api('POST', '/auth/verify-otp', {
    body: { phone_number: phone, code: sent.body.dev_otp, name },
  });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.body)}`);
  return { token: verified.body.token, customer: verified.body.customer, phone };
}

/** A new customer with a token signed the way sign-in signs it (no SMS code, no rate limit). */
async function createCustomer(name = 'Test Customer') {
  const phone = normalizePhone(nextPhone());
  const customer = await customerRepository.create({ name, phoneNumber: phone });
  const token = signToken({ sub: String(customer._id), phone });
  return { token, customer: { id: String(customer._id), name }, phone };
}

// Kigali city centre; test addresses are a few km from here.
const KITCHEN_POINT = { lat: -1.9441, lng: 30.0619 };
const NEARBY_ADDRESS = { address: 'KN 5 Rd, Kigali', latitude: -1.95, longitude: 30.07 };

/** An approved, open restaurant with the given dishes (name + price). */
async function createKitchen({ name = 'Test Kitchen', dishes = [], ...fields } = {}) {
  const vendor = await Vendor.create({
    name,
    vendor_type: 'restaurant',
    location: { type: 'Point', coordinates: [KITCHEN_POINT.lng, KITCHEN_POINT.lat] },
    address: 'KN 1 Ave',
    neighborhood: 'Nyarugenge',
    is_active: true,
    is_open: true,
    ...fields,
  });
  const items = await MenuItem.insertMany(
    dishes.map((dish) => ({ vendor_id: vendor._id, is_available: true, ...dish }))
  );
  return { vendor, items };
}

const MOBILE_MONEY = { payment_method: 'mobile_money', payment_details: { phone: '0788123456' } };

module.exports = {
  start,
  stop,
  api,
  signInCustomer,
  createCustomer,
  createKitchen,
  NEARBY_ADDRESS,
  MOBILE_MONEY,
};

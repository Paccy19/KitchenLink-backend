const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let normalizePhone;
let verifyToken;
let config;

let sequence = 0;
const freshPhone = () => {
  sequence += 1;
  return `073${String((process.pid + 4100) % 10000).padStart(4, '0')}${String(sequence).padStart(3, '0')}`;
};

before(async () => {
  await h.start();
  models = require('../../src/models');
  ({ normalizePhone } = require('../../src/utils/validators'));
  ({ verifyToken } = require('../../src/utils/jwt'));
  config = require('../../src/config');
});

after(async () => h.stop());

test('unified OTP login detects and authenticates the account role returned by the backend', async () => {
  const customerPhone = freshPhone();
  const customer = await models.Customer.create({
    name: 'Customer Login',
    phone_number: normalizePhone(customerPhone),
  });
  const customerOtp = await h.api('POST', '/auth/login/send-otp', { body: { identifier: customerPhone } });
  assert.equal(customerOtp.status, 200, JSON.stringify(customerOtp.body));
  assert.equal(customerOtp.body.role, 'customer');
  const customerSession = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: customerPhone, role: customerOtp.body.role, code: customerOtp.body.dev_otp },
  });
  assert.equal(customerSession.status, 200, JSON.stringify(customerSession.body));
  assert.equal(customerSession.body.role, 'customer');
  assert.equal(customerSession.body.customer.id, String(customer._id));

  const vendorPhone = freshPhone();
  await h.createKitchen({
    name: 'Unified Login Kitchen',
    owner_name: 'Vendor Login',
    phone: normalizePhone(vendorPhone),
  });
  const vendorOtp = await h.api('POST', '/auth/login/send-otp', { body: { identifier: vendorPhone } });
  assert.equal(vendorOtp.status, 200, JSON.stringify(vendorOtp.body));
  assert.equal(vendorOtp.body.role, 'vendor');
  const vendorSession = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: vendorPhone, role: vendorOtp.body.role, code: vendorOtp.body.dev_otp },
  });
  assert.equal(vendorSession.status, 200, JSON.stringify(vendorSession.body));
  assert.equal(vendorSession.body.role, 'vendor');
  assert.equal(verifyToken(vendorSession.body.token).role, config.vendor.jwtRole);

  const driverPhone = freshPhone();
  await models.Driver.create({
    name: 'Driver Login',
    phone: normalizePhone(driverPhone),
    verification_status: 'approved',
  });
  const driverOtp = await h.api('POST', '/auth/login/send-otp', { body: { identifier: driverPhone } });
  assert.equal(driverOtp.status, 200, JSON.stringify(driverOtp.body));
  assert.equal(driverOtp.body.role, 'driver');
  const driverSession = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: driverPhone, role: driverOtp.body.role, code: driverOtp.body.dev_otp },
  });
  assert.equal(driverSession.status, 200, JSON.stringify(driverSession.body));
  assert.equal(driverSession.body.role, 'driver');
  assert.equal(verifyToken(driverSession.body.token).role, config.delivery.jwtRole);
});

test('a linked identifier requires choosing an existing account type before sending a code', async () => {
  const phone = freshPhone();
  const name = 'Shared Account Owner';
  await h.createKitchen({
    name: 'Shared Account Kitchen',
    owner_name: name,
    phone: normalizePhone(phone),
  });
  const customer = await models.Customer.create({
    name,
    phone_number: normalizePhone(phone),
  });

  const ambiguous = await h.api('POST', '/auth/login/send-otp', { body: { identifier: phone } });
  assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.requires_role_selection, true);
  assert.deepEqual(ambiguous.body.roles, ['customer', 'vendor']);
  assert.equal(ambiguous.body.dev_otp, undefined);

  const send = await h.api('POST', '/auth/login/send-otp', { body: { identifier: phone, role: 'customer' } });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.equal(send.body.role, 'customer');
  const session = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: phone, role: 'customer', code: send.body.dev_otp },
  });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.equal(session.body.customer.id, String(customer._id));
});

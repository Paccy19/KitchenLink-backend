// Hidden admin sign-in through the customer phone login: stage 1 (customer
// sign-in code to the admin's verified phone) gives only a one-time
// challenge; stage 2 (that same admin's email + password) gives the admin
// session. Normal customers, shared phones, disabled admins and every attack
// path are covered. Sign-in routes allow 20 requests a minute, so most setup
// calls the services directly and the key paths go through HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let authService;
let adminPhoneLoginService;
let hashPassword;
let normalizePhone;
let signToken;

let seq = 0;
// Airtel 072…: never the 078… numbers testServer.createCustomer makes.
const freshPhone = () => {
  seq += 1;
  return `072${String(process.pid % 10000).padStart(4, '0')}${String(seq).padStart(3, '0')}`;
};

async function createAdmin({ email, password = 'Admin-Password-2026!', phone = freshPhone(), ...fields } = {}) {
  seq += 1;
  const admin = await models.Admin.create({
    name: 'Test Admin',
    email: email || `admin${seq}.${process.pid}@kitchenlink.test`,
    password_hash: await hashPassword(password),
    role: 'super_admin',
    status: 'active',
    is_active: true,
    phone: normalizePhone(phone),
    two_factor_enabled: true,
    ...fields,
  });
  return { admin: admin.toObject(), email: admin.email, password, phone };
}

/** Stage 1 through the services (no HTTP sign-in limit): send + verify the customer code. */
async function verifyPhone(phone, name = 'Test Person') {
  const sent = await authService.sendOtp({ phone_number: phone, name });
  return authService.verifyOtp({ phone_number: phone, code: sent.dev_otp, name });
}

before(async () => {
  await h.start();
  models = require('../../src/models');
  authService = require('../../src/services/authService');
  adminPhoneLoginService = require('../../src/services/adminPhoneLoginService');
  ({ hashPassword } = require('../../src/utils/password'));
  ({ normalizePhone } = require('../../src/utils/validators'));
  ({ signToken } = require('../../src/utils/jwt'));
});
after(() => h.stop());

test('a normal customer signs in exactly as before', async () => {
  const phone = freshPhone();
  const sent = await h.api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Aline Uwase' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const verified = await h.api('POST', '/auth/verify-otp', { body: { phone_number: phone, code: sent.body.dev_otp, name: 'Aline Uwase' } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.ok(verified.body.token);
  assert.equal(verified.body.customer.name, 'Aline Uwase');
  assert.equal(verified.body.admin_verification_required, undefined);
});

test('sending a code looks the same for an admin phone and any other phone (no enumeration)', async () => {
  const { phone } = await createAdmin();
  const adminSent = await h.api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Somebody' } });
  const otherSent = await h.api('POST', '/auth/send-otp', { body: { phone_number: freshPhone(), name: 'Somebody' } });
  assert.equal(adminSent.status, 200);
  assert.deepEqual(Object.keys(adminSent.body).sort(), Object.keys(otherSent.body).sort());
  assert.equal(adminSent.body.requires_name, otherSent.body.requires_name);
  assert.ok(!JSON.stringify(adminSent.body).includes('admin'));
});

test('admin: phone code → challenge only → own email + password → admin dashboard session', async () => {
  const { admin, email, password, phone } = await createAdmin();
  const sent = await h.api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Somebody' } });
  const verified = await h.api('POST', '/auth/verify-otp', { body: { phone_number: phone, code: sent.body.dev_otp, name: 'Somebody' } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.admin_verification_required, true);
  assert.ok(verified.body.challenge_token);
  assert.equal(verified.body.token, undefined, 'no customer (or admin) session after the phone step');
  assert.equal(verified.body.customer, undefined);
  assert.equal(await models.Customer.exists({ phone_number: normalizePhone(phone) }), null, 'no customer account was created');

  // The challenge is not an admin token.
  const challengeAsToken = await h.api('GET', '/admin/auth/me', { token: verified.body.challenge_token });
  assert.equal(challengeAsToken.status, 401);

  const done = await h.api('POST', '/admin/auth/phone-login', {
    body: { challenge_token: verified.body.challenge_token, email, password },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.token);
  assert.equal(done.body.admin.email, email);
  const me = await h.api('GET', '/admin/auth/me', { token: done.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.admin.role, 'super_admin', 'role and permissions unchanged');
  const dashboard = await h.api('GET', '/admin/dashboard/overview', { token: done.body.token });
  assert.equal(dashboard.status, 200, 'the admin dashboard works with this session');

  // Logged, and single-use.
  assert.ok(await models.AdminActionLog.exists({ admin_id: admin._id, action: 'auth.login' }));
  const reused = await h.api('POST', '/admin/auth/phone-login', {
    body: { challenge_token: verified.body.challenge_token, email, password },
  });
  assert.equal(reused.status, 401);
  assert.equal(reused.body.error.code, 'CHALLENGE_EXPIRED');

  // Signing out ends the admin session.
  const out = await h.api('POST', '/admin/auth/logout', { token: done.body.token });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await h.api('GET', '/admin/auth/me', { token: done.body.token })).status, 401);
});

test('wrong password, wrong email or another admin’s credentials are refused', async () => {
  const mine = await createAdmin();
  const other = await createAdmin({ password: 'Other-Admin-Pass-2026!' });
  const { challenge_token: token } = await verifyPhone(mine.phone);

  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email: mine.email, password: 'wrong-password' }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email: 'nobody@kitchenlink.test', password: mine.password }), { code: 'INVALID_CREDENTIALS' });
  // A valid admin's own email + password, but not the admin this phone belongs to.
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email: other.email, password: other.password }), { code: 'INVALID_CREDENTIALS' });
  assert.ok(await models.AdminActionLog.exists({ admin_id: mine.admin._id, action: 'auth.login_failed' }));

  // Still within the attempt limit: the right credentials work.
  const session = await adminPhoneLoginService.complete({ challenge_token: token, email: mine.email, password: mine.password });
  assert.equal(session.admin.email, mine.email);
});

test('too many wrong passwords kill the challenge', async () => {
  const { email, password, phone } = await createAdmin();
  const { challenge_token: token } = await verifyPhone(phone);
  for (let i = 0; i < adminPhoneLoginService.MAX_ATTEMPTS; i += 1) {
    await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email, password: `wrong-${i}` }));
  }
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email, password }), (error) =>
    ['CHALLENGE_EXPIRED', 'LOGIN_LOCKED'].includes(error.code)
  );
});

test('an expired or forged challenge is refused', async () => {
  const { email, password, phone } = await createAdmin();
  const { challenge_token: token } = await verifyPhone(phone);
  await models.AdminLoginChallenge.updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email, password }), { code: 'CHALLENGE_EXPIRED' });
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: 'x'.repeat(43), email, password }), { code: 'CHALLENGE_EXPIRED' });
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: undefined, email, password }), { code: 'CHALLENGE_EXPIRED' });
});

test('disabled, deleted and invited admins only get the normal customer sign-in', async () => {
  for (const fields of [{ is_active: false }, { deleted_at: new Date() }, { status: 'invited' }]) {
    const { phone } = await createAdmin(fields);
    const result = await verifyPhone(phone, 'Former Admin');
    assert.equal(result.admin_verification_required, undefined, JSON.stringify(fields));
    assert.ok(result.token, 'a customer session as for anyone');
  }
});

test('an admin saved before `status` existed (like the first owner) can use the phone sign-in', async () => {
  const { admin, email, password, phone } = await createAdmin();
  await models.Admin.collection.updateOne({ _id: admin._id }, { $unset: { status: '' } });
  const { challenge_token: token } = await verifyPhone(phone);
  assert.ok(token, 'stage 2 offered');
  const session = await adminPhoneLoginService.complete({ challenge_token: token, email, password });
  assert.equal(session.admin.email, email);
});

test('the admin is deactivated between the two stages: no session', async () => {
  const { admin, email, password, phone } = await createAdmin();
  const { challenge_token: token } = await verifyPhone(phone);
  await models.Admin.updateOne({ _id: admin._id }, { $set: { is_active: false } });
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: token, email, password }), { code: 'CHALLENGE_EXPIRED' });
});

test('a phone that is both a customer’s and an admin’s: continue as the same customer, accounts untouched', async () => {
  const phone = freshPhone();
  const customer = await models.Customer.create({ name: 'Grace Ingabire', phone_number: normalizePhone(phone) });
  const { admin, email, password } = await createAdmin({ phone });

  const sent = await h.api('POST', '/auth/send-otp', { body: { phone_number: phone } });
  const verified = await h.api('POST', '/auth/verify-otp', { body: { phone_number: phone, code: sent.body.dev_otp } });
  assert.equal(verified.body.admin_verification_required, true);

  const asCustomer = await h.api('POST', '/auth/continue-as-customer', { body: { challenge_token: verified.body.challenge_token } });
  assert.equal(asCustomer.status, 200, JSON.stringify(asCustomer.body));
  assert.equal(asCustomer.body.customer.id, String(customer._id), 'the existing customer account, not a new one');
  assert.equal(asCustomer.body.customer.name, 'Grace Ingabire');
  const me = await h.api('GET', '/auth/me', { token: asCustomer.body.token });
  assert.equal(me.status, 200);

  // The challenge was used up: it can no longer finish the admin sign-in.
  await assert.rejects(adminPhoneLoginService.complete({ challenge_token: verified.body.challenge_token, email, password }), { code: 'CHALLENGE_EXPIRED' });
  const after = await models.Admin.findById(admin._id).lean();
  assert.equal(after.email, email);
  assert.equal(after.role, 'super_admin');
  assert.equal(await models.Customer.countDocuments({ phone_number: normalizePhone(phone) }), 1);
});

test('a customer token (or a forged role) never opens admin APIs', async () => {
  const { token } = await h.createCustomer();
  const res = await h.api('GET', '/admin/dashboard/overview', { token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ADMIN_ONLY');
  // A token claiming the admin role but not signed by the server is rejected.
  const forged = `${token.split('.').slice(0, 2).join('.')}.forged-signature`;
  assert.equal((await h.api('GET', '/admin/auth/me', { token: forged })).status, 401);
  // A real customer id with role: admin points at no admin account.
  const customer = await models.Customer.findOne().lean();
  const wrongSubject = signToken({ sub: String(customer._id), role: 'admin' });
  assert.equal((await h.api('GET', '/admin/auth/me', { token: wrongSubject })).status, 401);
});

test('codes are stored hashed, used once, and refused when wrong or expired', async () => {
  const phone = freshPhone();
  const sent = await authService.sendOtp({ phone_number: phone, name: 'Code Tester' });
  const stored = await models.OtpCode.findOne({ phone_number: normalizePhone(phone) }).lean();
  assert.equal(stored.code, null, 'no plaintext code in the database');
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.code_hash, sent.dev_otp);

  const wrong = sent.dev_otp === '111111' ? '222222' : '111111';
  await assert.rejects(authService.verifyOtp({ phone_number: phone, code: wrong, name: 'Code Tester' }), { code: 'OTP_INVALID' });
  await authService.verifyOtp({ phone_number: phone, code: sent.dev_otp, name: 'Code Tester' });
  await assert.rejects(authService.verifyOtp({ phone_number: phone, code: sent.dev_otp, name: 'Code Tester' }), (error) =>
    ['OTP_NOT_FOUND', 'OTP_EXPIRED'].includes(error.code)
  );

  const later = freshPhone();
  const sentLater = await authService.sendOtp({ phone_number: later, name: 'Code Tester' });
  await models.OtpCode.updateOne({ phone_number: normalizePhone(later) }, { $set: { expires_at: new Date(Date.now() - 1000) } });
  await assert.rejects(authService.verifyOtp({ phone_number: later, code: sentLater.dev_otp, name: 'Code Tester' }), { code: 'OTP_EXPIRED' });
});

test('a code created before hashing still works once (backward compatible)', async () => {
  const phone = normalizePhone(freshPhone());
  await models.OtpCode.create({ phone_number: phone, code: '654321', expires_at: new Date(Date.now() + 60000), name: 'Legacy Code' });
  const session = await authService.verifyOtp({ phone_number: phone, code: '654321', name: 'Legacy Code' });
  assert.ok(session.token);
});

test('vendor and delivery worker sign-in codes still work (shared, now hashed, code store)', async () => {
  const vendorPhone = freshPhone();
  await h.createKitchen({ name: 'OTP Kitchen', phone: normalizePhone(vendorPhone) });
  const vendorSent = await h.api('POST', '/vendor/auth/send-otp', { body: { phone: vendorPhone } });
  assert.equal(vendorSent.status, 200, JSON.stringify(vendorSent.body));
  const vendorIn = await h.api('POST', '/vendor/auth/verify-otp', { body: { phone: vendorPhone, code: vendorSent.body.dev_otp } });
  assert.equal(vendorIn.status, 200, JSON.stringify(vendorIn.body));
  assert.ok(vendorIn.body.token);

  const driverPhone = freshPhone();
  const registered = await h.api('POST', '/driver/auth/register', {
    body: { name: 'Eric Uwimana', phone: driverPhone, vehicle_type: 'motorcycle', plate_number: 'RAD 900 Z' },
  });
  assert.ok([200, 201].includes(registered.status), JSON.stringify(registered.body));
  const driverSent = await h.api('POST', '/driver/auth/send-otp', { body: { phone: driverPhone } });
  assert.equal(driverSent.status, 200, JSON.stringify(driverSent.body));
  const driverIn = await h.api('POST', '/driver/auth/verify-otp', { body: { phone: driverPhone, code: driverSent.body.dev_otp } });
  assert.equal(driverIn.status, 200, JSON.stringify(driverIn.body));
  assert.ok(driverIn.body.token);
});

test('the password sign-in at the private admin page still works', async () => {
  const { email, password } = await createAdmin({ two_factor_enabled: false });
  const res = await h.api('POST', '/admin/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let normalizePhone;
let hashPassword;
let sequence = 0;

const freshPhone = () => {
  sequence += 1;
  return `072${String(process.pid % 10000).padStart(4, '0')}${String(sequence).padStart(3, '0')}`;
};

async function createAdmin(fields = {}) {
  const phone = fields.phone || normalizePhone(freshPhone());
  const email = fields.email || `admin-${process.pid}-${sequence}@kitchenlink.test`;
  const password = fields.password || 'Admin-Password-2026!';
  const admin = await models.Admin.create({
    name: 'Test Admin',
    email,
    password_hash: await hashPassword(password),
    role: 'super_admin',
    status: 'active',
    is_active: true,
    phone,
    two_factor_enabled: true,
    ...fields,
  });
  return { admin, email, password, phone };
}

before(async () => {
  await h.start();
  models = require('../../src/models');
  ({ normalizePhone } = require('../../src/utils/validators'));
  ({ hashPassword } = require('../../src/utils/password'));
});

after(async () => h.stop());

test('admin email and phone require password and never create or deliver an OTP', async () => {
  const { admin, email, password, phone } = await createAdmin();

  for (const identifier of [email, phone]) {
    const start = await h.api('POST', '/auth/login/send-otp', {
      body: { identifier, role: 'customer' },
    });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.role, 'admin');
    assert.equal(start.body.requires_password, true);
    assert.equal(start.body.dev_otp, undefined);
  }

  const customerOtpStart = await h.api('POST', '/auth/send-otp', {
    body: { identifier: phone, name: 'Test Admin' },
  });
  assert.equal(customerOtpStart.status, 400);
  assert.equal(customerOtpStart.body.error.code, 'PASSWORD_REQUIRED');

  const otpVerify = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: phone, role: 'customer', code: '123456' },
  });
  assert.equal(otpVerify.status, 400);
  assert.equal(otpVerify.body.error.code, 'PASSWORD_REQUIRED');
  assert.equal(await models.OtpCode.countDocuments({ phone_number: { $in: [email, phone] } }), 0);

  const wrongPassword = await h.api('POST', '/admin/auth/login', {
    body: { identifier: phone, password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.token, undefined);

  const signedIn = await h.api('POST', '/admin/auth/login', {
    body: { identifier: phone, password },
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.admin.email, email);
  assert.equal(signedIn.body.two_factor_required, undefined);

  const signedInWithEmail = await h.api('POST', '/admin/auth/login', {
    body: { identifier: email, password },
  });
  assert.equal(signedInWithEmail.status, 200, JSON.stringify(signedInWithEmail.body));
  assert.equal(signedInWithEmail.body.admin.email, email);
  assert.equal(signedInWithEmail.body.two_factor_required, undefined);

  assert.equal(await models.OtpCode.countDocuments({ phone_number: { $in: [email, phone] } }), 0);
  assert.ok((await models.Admin.findById(admin._id).lean()).last_login_at);
  assert.equal((await h.api('GET', '/admin/dashboard/overview', { token: signedIn.body.token })).status, 200);
});

test('password authentication rejects non-admin identifiers and unauthorized account states', async () => {
  const customerPhone = normalizePhone(freshPhone());
  await models.Customer.create({ name: 'Customer Account', phone_number: customerPhone });
  const customerLogin = await h.api('POST', '/admin/auth/login', {
    body: { identifier: customerPhone, password: 'some-password' },
  });
  assert.equal(customerLogin.status, 401);
  assert.equal(customerLogin.body.token, undefined);

  const disabled = await createAdmin({ is_active: false });
  const disabledLogin = await h.api('POST', '/admin/auth/login', {
    body: { identifier: disabled.email, password: disabled.password },
  });
  assert.equal(disabledLogin.status, 403);
  assert.equal(disabledLogin.body.error.code, 'ADMIN_DISABLED');

  const invited = await createAdmin({ status: 'invited' });
  const invitedLogin = await h.api('POST', '/admin/auth/login', {
    body: { identifier: invited.phone, password: invited.password },
  });
  assert.equal(invitedLogin.status, 403);
  assert.equal(invitedLogin.body.error.code, 'INVITATION_PENDING');
});

test('ordinary role OTP authentication and protected admin routes remain role-separated', async () => {
  const phone = normalizePhone(freshPhone());
  await models.Customer.create({ name: 'OTP Customer', phone_number: phone });
  const otpStart = await h.api('POST', '/auth/login/send-otp', { body: { identifier: phone } });
  assert.equal(otpStart.status, 200, JSON.stringify(otpStart.body));
  assert.equal(otpStart.body.role, 'customer');
  assert.equal(otpStart.body.requires_password, undefined);
  const customer = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: phone, role: 'customer', code: otpStart.body.dev_otp },
  });
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  assert.equal(customer.body.role, 'customer');
  assert.equal((await h.api('GET', '/admin/dashboard/overview', { token: customer.body.token })).status, 403);
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, signInCustomer, createKitchen } = require('../helpers/testServer');
const { Driver } = require('../../src/models');
const { normalizePhone } = require('../../src/utils/validators');

before(start);
after(stop);

test('health check answers', async () => {
  const res = await api('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('a new customer signs up with an SMS code and gets a working token', async () => {
  const { token, customer } = await signInCustomer('Aline');
  assert.ok(token);
  assert.equal(customer.name, 'Aline');

  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.customer.id, customer.id);
});

test('a wrong code is refused', async () => {
  const phone = '0788000001';
  const sent = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Eric' } });
  assert.equal(sent.status, 200);
  const wrong = sent.body.dev_otp === '111111' ? '222222' : '111111';

  const res = await api('POST', '/auth/verify-otp', { body: { phone_number: phone, code: wrong, name: 'Eric' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.token, undefined);
});

test('a second code cannot be requested straight away', async () => {
  const phone = '0788000002';
  assert.equal((await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Jo' } })).status, 200);
  const again = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Jo' } });
  assert.equal(again.status, 429);
  assert.equal(again.body.error.code, 'OTP_RESEND_TOO_SOON');
});

test('an invalid phone number is refused', async () => {
  const res = await api('POST', '/auth/send-otp', { body: { phone_number: '12345', name: 'X' } });
  assert.equal(res.status, 400);
});

test('customer pages need a token', async () => {
  assert.equal((await api('GET', '/auth/me')).status, 401);
  assert.equal((await api('GET', '/cart')).status, 401);
  assert.equal((await api('GET', '/orders')).status, 401);
});

test('a forged token is refused', async () => {
  const res = await api('GET', '/auth/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.bad' });
  assert.equal(res.status, 401);
});

test('signing out stops the token working', async () => {
  const { token } = await signInCustomer('Sam');
  assert.equal((await api('POST', '/auth/logout', { token })).status, 200);
  assert.equal((await api('GET', '/auth/me', { token })).status, 401);
});

test('a kitchen owner signing in as a customer must give the name they registered with', async () => {
  const phone = '0788000101';
  await createKitchen({ name: 'Inzu Kitchen', owner_name: 'Aline Uwase', phone: normalizePhone(phone) });

  const wrong = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Someone Else' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'NAME_DOES_NOT_MATCH');
  assert.equal(wrong.body.dev_otp, undefined, 'no code is sent for a wrong name');
  assert.ok(!JSON.stringify(wrong.body).includes('Uwase'), 'the registered name is never revealed');

  // Case, spacing and word order don't matter; the account gets the registered name.
  const sent = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: '  uwase   ALINE ' } });
  assert.equal(sent.status, 200);
  const verified = await api('POST', '/auth/verify-otp', {
    body: { phone_number: phone, code: sent.body.dev_otp, name: '  uwase   ALINE ' },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.customer.name, 'Aline Uwase');
});

test('a delivery worker signing in as a customer must give the name they registered with', async () => {
  const phone = '0788000102';
  await Driver.create({ name: 'Eric Habimana', phone: normalizePhone(phone) });

  const missing = await api('POST', '/auth/send-otp', { body: { phone_number: phone } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'NAME_REQUIRED');

  const wrong = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Eric' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'NAME_DOES_NOT_MATCH');

  const sent = await api('POST', '/auth/send-otp', { body: { phone_number: phone, name: 'Eric Habimana' } });
  assert.equal(sent.status, 200);
  // The name is checked again when the code is verified.
  const tampered = await api('POST', '/auth/verify-otp', {
    body: { phone_number: phone, code: sent.body.dev_otp, name: 'Not Eric' },
  });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.body.error.code, 'NAME_DOES_NOT_MATCH');
});

test('MongoDB operators in a body are refused', async () => {
  const res = await api('POST', '/auth/send-otp', { body: { phone_number: { $gt: '' } } });
  assert.equal(res.status, 400);
});

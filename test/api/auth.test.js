const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, signInCustomer } = require('../helpers/testServer');

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

test('MongoDB operators in a body are refused', async () => {
  const res = await api('POST', '/auth/send-otp', { body: { phone_number: { $gt: '' } } });
  assert.equal(res.status, 400);
});

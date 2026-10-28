const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  parseQuantity,
  parsePaymentDetails,
  parseDeliveryLocation,
} = require('../../src/utils/validators');

test('phone numbers are stored in one format', () => {
  for (const raw of ['0788123456', '+250788123456', '250788123456', '078 812-3456']) {
    assert.equal(normalizePhone(raw), '+250788123456', raw);
  }
});

test('invalid phone numbers are refused', () => {
  for (const raw of ['12345', '0688123456', '+2507881234567', '', null, { $gt: '' }]) {
    assert.throws(() => normalizePhone(raw), undefined, String(raw));
  }
});

test('quantity defaults to 1 and stays between 1 and 99', () => {
  assert.equal(parseQuantity(undefined), 1);
  assert.equal(parseQuantity('3'), 3);
  assert.throws(() => parseQuantity(undefined, { required: true }));
  for (const raw of [0, -2, 2.5, 100, 'two']) {
    assert.throws(() => parseQuantity(raw), undefined, String(raw));
  }
});

test('cards keep only the last 4 digits and must pass the Luhn check', () => {
  const card = parsePaymentDetails('card', { card_number: '4242 4242 4242 4242', card_expiry: '12/99' });
  assert.equal(card.card_number, '•••• 4242');
  assert.throws(() => parsePaymentDetails('card', { card_number: '4242424242424241', card_expiry: '12/99' }));
  assert.throws(() => parsePaymentDetails('card', { card_number: '4242424242424242', card_expiry: '01/20' }));
});

test('mobile money must be an MTN or Airtel number', () => {
  assert.equal(parsePaymentDetails('mobile_money', { phone: '+250788123456' }).phone, '0788123456');
  assert.equal(parsePaymentDetails('mobile_money', { phone: '0731234567' }).phone, '0731234567');
  assert.throws(() => parsePaymentDetails('mobile_money', { phone: '0721234567' }));
});

test('a delivery address needs real coordinates', () => {
  const ok = parseDeliveryLocation({ address: 'KN 5 Rd', latitude: '-1.95', longitude: '30.07' });
  assert.equal(ok.latitude, -1.95);
  for (const bad of [
    null,
    { latitude: -1.95, longitude: 30.07 },
    { address: 'KN 5 Rd', latitude: '', longitude: '' },
    { address: 'KN 5 Rd', latitude: 95, longitude: 30 },
  ]) {
    assert.throws(() => parseDeliveryLocation(bad), undefined, JSON.stringify(bad));
  }
});

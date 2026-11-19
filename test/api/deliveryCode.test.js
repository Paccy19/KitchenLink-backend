// The customer's delivery confirmation code: issued when the food is ready,
// sent only to the customer's verified email, never shown to the delivery
// worker or in any API response, bound to one order, single use, with expiry
// and attempt limits. Only the assigned worker's correct code delivers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let config;
let signToken;
let deliveryService;
let setTestTransport;
let kitchen;
const outbox = [];

before(async () => {
  await h.start();
  models = require('../../src/models');
  config = require('../../src/config');
  ({ signToken } = require('../../src/utils/jwt'));
  deliveryService = require('../../src/services/deliveryService');
  ({ setTestTransport } = require('../../src/utils/email'));
  setTestTransport((message) => {
    outbox.push(message);
    return { status: 'sent' };
  });
  kitchen = await h.createKitchen({ name: 'Code Kitchen', dishes: [{ name: 'Isombe', price_rwf: 4000 }] });
});
after(async () => {
  setTestTransport(null);
  await h.stop();
});

let seq = 0;
async function driver() {
  seq += 1;
  const doc = await models.Driver.create({
    name: `Rider ${seq}`,
    phone: `+25073${String((process.pid + seq) % 10000).padStart(4, '0')}${String(seq).padStart(3, '0')}`,
    verification_status: 'approved',
  });
  return { driver: doc.toObject(), token: signToken({ sub: String(doc._id), role: config.delivery.jwtRole }) };
}

/** A paid delivery order, food ready (code issued), out for delivery with `rider`. */
async function deliveryOnTheWay({ rider, verifiedEmail = true } = {}) {
  const customer = await h.createCustomer('Code Customer');
  seq += 1;
  const email = `customer${seq}.${process.pid}@kitchenlink.test`;
  if (verifiedEmail) await models.Customer.updateOne({ _id: customer.customer.id }, { $set: { email, email_verified_at: new Date() } });
  await h.api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id), quantity: 1 } });
  const checkout = await h.api('POST', '/orders/checkout', { token: customer.token, body: { delivery_location: h.NEARBY_ADDRESS, ...h.MOBILE_MONEY } });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const orderId = checkout.body.id;
  const before = outbox.length;
  await models.Order.updateOne({ _id: orderId }, { $set: { status: 'ready' } });
  await deliveryService.handleOrderReady(await models.Order.findById(orderId).lean());
  const delivery = await models.Delivery.findOne({ order_id: orderId }).lean();
  assert.ok(delivery, 'a delivery exists');
  await models.Delivery.updateOne({ _id: delivery._id }, { $set: { driver_id: rider.driver._id, status: 'out_for_delivery', picked_up_at: new Date() } });
  const mail = outbox.slice(before).find((message) => message.to === email);
  const code = mail ? mail.text.match(/\b(\d{6})\b/)[1] : null;
  return { customer, email, orderId, deliveryId: String(delivery._id), code };
}

const confirm = (rider, deliveryId, code) =>
  h.api('POST', `/driver/deliveries/${deliveryId}/confirm-delivery`, { token: rider.token, body: { otp_code: code } });
const other = (code) => (code === '111111' ? '222222' : '111111');

test('the code goes only to the customer’s verified email; the right code from the assigned worker delivers the order', async () => {
  const rider = await driver();
  const { customer, email, orderId, deliveryId, code } = await deliveryOnTheWay({ rider });
  assert.ok(code, 'emailed to the customer');
  assert.equal(outbox.filter((message) => message.text.includes(code)).every((message) => message.to === email), true, 'only to the customer');

  const stored = await models.Delivery.findById(deliveryId).lean();
  assert.equal(stored.otp_code, '', 'no plaintext code stored');
  assert.ok(stored.otp_code_hash && !stored.otp_code_hash.includes(code));
  assert.equal(stored.otp_channel, 'email');

  // Never in what the worker or the customer's screens receive.
  const active = await h.api('GET', '/driver/deliveries/active', { token: rider.token });
  assert.ok(!JSON.stringify(active.body).includes(code), 'not in the worker’s deliveries');
  const detail = await h.api('GET', `/orders/${orderId}`, { token: customer.token });
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes(code), 'not in the customer’s order screen');
  const notifications = await h.api('GET', '/notifications', { token: customer.token });
  assert.ok(!JSON.stringify(notifications.body).includes(code), 'not in notifications');

  // Not delivered by a status change alone.
  const skip = await h.api('PATCH', `/driver/deliveries/${deliveryId}/status`, { token: rider.token, body: { status: 'delivered' } });
  assert.ok([400, 409].includes(skip.status), `refused (${skip.status})`);
  assert.notEqual((await models.Order.findById(orderId).lean()).status, 'delivered');

  const done = await confirm(rider, deliveryId, code);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(!JSON.stringify(done.body).includes(code));
  assert.equal((await models.Order.findById(orderId).lean()).status, 'delivered');

  // Used once.
  const again = await confirm(rider, deliveryId, code);
  assert.equal(again.status, 409);
});

test('a wrong code, an expired code, another order’s code or another worker never deliver', async () => {
  const rider = await driver();
  const first = await deliveryOnTheWay({ rider });
  const second = await deliveryOnTheWay({ rider });
  assert.notEqual(first.code, null);

  const wrong = await confirm(rider, first.deliveryId, other(first.code));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'OTP_INVALID');

  // The second order's code does not confirm the first (codes are bound to their order).
  if (second.code !== first.code) {
    const crossed = await confirm(rider, first.deliveryId, second.code);
    assert.equal(crossed.status, 400);
  }

  // A worker who isn't assigned can't confirm it, even with the right code.
  const stranger = await driver();
  assert.equal((await confirm(stranger, first.deliveryId, first.code)).status, 404);

  await models.Delivery.updateOne({ _id: first.deliveryId }, { $set: { otp_expires_at: new Date(Date.now() - 1000) } });
  const expired = await confirm(rider, first.deliveryId, first.code);
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, 'DELIVERY_CODE_EXPIRED');
  assert.notEqual((await models.Order.findById(first.orderId).lean()).status, 'delivered');

  // The second order is still confirmable with its own code.
  assert.equal((await confirm(rider, second.deliveryId, second.code)).status, 200);
});

test('five wrong codes lock the delivery, even for the right code', async () => {
  const rider = await driver();
  const { deliveryId, orderId, code } = await deliveryOnTheWay({ rider });
  for (let i = 0; i < 5; i += 1) assert.equal((await confirm(rider, deliveryId, other(code))).status, 400);
  const locked = await confirm(rider, deliveryId, code);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'DELIVERY_CODE_LOCKED');
  assert.notEqual((await models.Order.findById(orderId).lean()).status, 'delivered');
});

test('no verified email: nothing is skipped, the customer is told, and can get the code once they verify one', async () => {
  const rider = await driver();
  const { customer, orderId, deliveryId, code } = await deliveryOnTheWay({ rider, verifiedEmail: false });
  assert.equal(code, null, 'nothing emailed');
  const delivery = await models.Delivery.findById(deliveryId).lean();
  assert.equal(delivery.otp_channel, 'none');
  assert.ok(delivery.otp_code_hash, 'a code still guards the delivery');

  const detail = await h.api('GET', `/orders/${orderId}`, { token: customer.token });
  assert.equal(detail.body.delivery.code_needs_channel, true);
  const notifications = await h.api('GET', '/notifications', { token: customer.token });
  assert.ok(JSON.stringify(notifications.body).includes('verify your email'), 'the customer is told what to do');

  // Worker side: told the customer has no way to receive it (support steps in).
  const active = await h.api('GET', '/driver/deliveries/active', { token: rider.token });
  assert.ok(JSON.stringify(active.body).includes('"otp_customer_has_no_channel":true'));

  const refused = await h.api('POST', `/orders/${orderId}/delivery-code/resend`, { token: customer.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'NO_DELIVERY_CODE_CHANNEL');

  // The customer verifies an email, then asks again (a minute after the first code).
  const email = `late.${process.pid}@kitchenlink.test`;
  await models.Customer.updateOne({ _id: customer.customer.id }, { $set: { email, email_verified_at: new Date() } });
  await models.Delivery.updateOne({ _id: deliveryId }, { $set: { otp_issued_at: new Date(Date.now() - 2 * 60 * 1000) } });
  const sentBefore = outbox.length;
  const resent = await h.api('POST', `/orders/${orderId}/delivery-code/resend`, { token: customer.token });
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  assert.equal(resent.body.channel, 'email');
  const mail = outbox.slice(sentBefore).find((message) => message.to === email);
  const newCode = mail.text.match(/\b(\d{6})\b/)[1];
  assert.ok(!JSON.stringify(resent.body).includes(newCode), 'the code is not in the response');

  // Asking again straight away is refused.
  assert.equal((await h.api('POST', `/orders/${orderId}/delivery-code/resend`, { token: customer.token })).status, 429);
  assert.equal((await confirm(rider, deliveryId, newCode)).status, 200);
});

test('a new code replaces the old one', async () => {
  const rider = await driver();
  const { customer, orderId, deliveryId, code, email } = await deliveryOnTheWay({ rider });
  await models.Delivery.updateOne({ _id: deliveryId }, { $set: { otp_issued_at: new Date(Date.now() - 2 * 60 * 1000) } });
  const sentBefore = outbox.length;
  assert.equal((await h.api('POST', `/orders/${orderId}/delivery-code/resend`, { token: customer.token })).status, 200);
  const newCode = outbox.slice(sentBefore).find((message) => message.to === email).text.match(/\b(\d{6})\b/)[1];
  if (newCode !== code) assert.equal((await confirm(rider, deliveryId, code)).status, 400, 'the old code stopped working');
  assert.equal((await confirm(rider, deliveryId, newCode)).status, 200);
});

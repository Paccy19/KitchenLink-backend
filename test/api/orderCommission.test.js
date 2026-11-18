// Admin-set commission per order: replaces the commission rules for that
// order until it is settled, recalculates the kitchen's payout, is used at
// payment and settlement, keeps the books balanced, and is logged.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let kitchen;
let models;
let adminOrderService;
let settlementService;
let platformLedgerService;

before(async () => {
  await h.start();
  models = require('../../src/models');
  adminOrderService = require('../../src/services/adminOrderService');
  settlementService = require('../../src/services/settlementService');
  platformLedgerService = require('../../src/services/platformLedgerService');
  kitchen = await h.createKitchen({
    name: 'Commission Kitchen',
    // 10,000 RWF of food per order.
    dishes: [{ name: 'Buffet tray', price_rwf: 10000 }],
  });
});
after(() => h.stop());

async function placeOrder(extra = {}) {
  const customer = await h.createCustomer();
  await h.api('POST', '/cart', { token: customer.token, body: { menu_item_id: String(kitchen.items[0]._id), quantity: 1 } });
  const res = await h.api('POST', '/orders/checkout', {
    token: customer.token,
    body: { delivery_location: h.NEARBY_ADDRESS, ...h.MOBILE_MONEY, ...extra },
  });
  assert.ok([200, 402].includes(res.status), JSON.stringify(res.body));
  return { token: customer.token, orderId: res.body.id ?? res.body.order_id ?? res.body.order?.id };
}

const unreconciled = async () => (await platformLedgerService.snapshot()).unreconciled_rwf;
const setCommission = (orderId, body) => adminOrderService.setCommission(orderId, body, null);

test('a held order gets the admin commission now: commission and kitchen payout recalculated, used at settlement', async () => {
  const before = await unreconciled();
  const { orderId } = await placeOrder();
  let order = await models.Order.findById(orderId).lean();
  assert.equal(order.settlement_status, 'held');
  const ruleCommission = order.commission_rwf;

  const result = await setCommission(orderId, { percent: 5, reason: 'Launch promotion for this kitchen' });
  assert.equal(result.commission.percent, 5);
  assert.equal(result.order.commission_percent, 5);
  assert.equal(result.order.commission_rwf, 500);
  assert.equal(result.order.vendor_payout_rwf, 9500);
  assert.deepEqual(result.order.commission_override.percent, 5);
  assert.equal(result.order.commission_history.length, 1);
  assert.equal(result.order.commission_history[0].reason, 'Launch promotion for this kitchen');
  assert.equal(result.order.commission_editable, true);
  assert.notEqual(ruleCommission, 500, 'the rule (default %) was different');
  assert.equal(await unreconciled(), before, 'changing the split moves no money');

  // Completing the order pays the kitchen with the admin's commission.
  const balanceBefore = (await models.Vendor.findById(kitchen.vendor._id).lean()).available_balance;
  await adminOrderService.updateStatus(orderId, { status: 'delivered' }, null);
  order = await models.Order.findById(orderId).lean();
  assert.equal(order.settlement_status, 'settled');
  assert.equal(order.commission_percent, 5);
  const balanceAfter = (await models.Vendor.findById(kitchen.vendor._id).lean()).available_balance;
  assert.equal(balanceAfter - balanceBefore, 9500);
  const commissionEntry = await models.Transaction.findOne({ order_id: orderId, type: 'commission' }).lean();
  assert.equal(commissionEntry.amount_rwf, 500);
  assert.equal(await unreconciled(), before);

  // Settled: locked.
  await assert.rejects(setCommission(orderId, { percent: 10, reason: 'too late' }), { code: 'COMMISSION_LOCKED' });
});

test('an unpaid order keeps the admin commission for when the customer pays', async () => {
  const { token, orderId } = await placeOrder({ payment_simulate: 'fail' });
  let order = await models.Order.findById(orderId).lean();
  assert.equal(order.settlement_status, 'unpaid');

  await setCommission(orderId, { percent: 0, reason: 'Charity event, no commission' });
  const paid = await h.api('POST', `/orders/${orderId}/pay`, { token, body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  order = await models.Order.findById(orderId).lean();
  assert.equal(order.settlement_status, 'held');
  assert.equal(order.commission_percent, 0);
  assert.equal(order.commission_rwf, 0);
  assert.equal(order.vendor_payout_rwf, 10000);
});

test('clearing goes back to the commission rules; bad values and missing reasons are refused', async () => {
  const { orderId } = await placeOrder();
  const rule = (await models.Order.findById(orderId).lean()).commission_percent;
  await setCommission(orderId, { percent: 2.5, reason: 'Trial' });
  const cleared = await setCommission(orderId, { percent: null, reason: 'Trial over' });
  assert.equal(cleared.order.commission_override, null);
  assert.equal(cleared.order.commission_percent, rule);
  assert.equal(cleared.order.commission_history.length, 2);
  assert.equal(cleared.order.commission_history[1].to_percent, null);

  await assert.rejects(setCommission(orderId, { percent: 150, reason: 'x' }), { statusCode: 400 });
  await assert.rejects(setCommission(orderId, { percent: -1, reason: 'x' }), { statusCode: 400 });
  await assert.rejects(setCommission(orderId, { percent: 5 }), { statusCode: 400 });
});

test('a cancelled (refunded) order cannot get a new commission', async () => {
  const { token, orderId } = await placeOrder();
  await h.api('POST', `/orders/${orderId}/cancel`, { token, body: {} });
  await assert.rejects(setCommission(orderId, { percent: 1, reason: 'x' }), { code: 'COMMISSION_LOCKED' });
});

test('a kitchen that delivers itself keeps the delivery fee whatever the commission', () => {
  const split = settlementService.splitForPercent(
    { subtotal_rwf: 100000, delivery_fee_rwf: 20000, fulfillment: 'vendor_delivery' },
    12.5
  );
  assert.equal(split.commissionRwf, 12500, 'commission is on food only');
  assert.equal(split.vendorPayout, 100000 - 12500 + 20000);
});

test('the admin endpoint needs an admin sign-in', async () => {
  const { orderId } = await placeOrder();
  const res = await h.api('PUT', `/admin/orders/${orderId}/commission`, { body: { percent: 1, reason: 'x' } });
  assert.equal(res.status, 401);
});

// Refunds for special deliveries (big events) when support resolves a
// dispute: delivery fee reductions (unpaid balance first, then cash for what
// was overpaid), cancellations net of earlier refunds, the kitchen's payout
// frozen during a dispute, and the platform books staying balanced.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const osrm = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 130000, duration: 3600 }] }));
});

let h;
let models;
let specialDeliveryService;
let adminOrderService;
let platformLedgerService;
let caterer;
let caterTok;

const DAY_MS = 24 * 60 * 60 * 1000;
const PACKAGE = {
  id: 'wedding1',
  name: 'Wedding buffet',
  enabled: true,
  tiers: [{ min_guests: 50, max_guests: 300, price_per_plate_rwf: 5000 }],
  menu: ['Rice', 'Beef'],
};

before(async () => {
  await new Promise((resolve) => osrm.listen(0, '127.0.0.1', resolve));
  process.env.ROUTING_PROVIDER = 'osrm';
  process.env.OSRM_URL = `http://127.0.0.1:${osrm.address().port}`;
  process.env.OSRM_MIN_INTERVAL_MS = '0';
  h = require('../helpers/testServer');
  models = require('../../src/models');
  specialDeliveryService = require('../../src/services/specialDeliveryService');
  adminOrderService = require('../../src/services/adminOrderService');
  platformLedgerService = require('../../src/services/platformLedgerService');
  const config = require('../../src/config');
  const { signToken } = require('../../src/utils/jwt');
  await h.start();
  await require('../../src/services/bigEventDeliverySettingsService').load();
  ({ vendor: caterer } = await h.createKitchen({
    name: 'Dispute Caterer',
    event_package: { enabled: true, packages: [PACKAGE] },
    // Kigali only: Huye (≈ 130 km) is outside, so it needs a special delivery.
    delivery_coverage: { big_event_enabled: true, areas: [{ id: 'radius01', kind: 'radius', radius_km: 20 }] },
  }));
  caterTok = signToken({ sub: String(caterer._id), role: config.vendor.jwtRole });
});
after(async () => {
  await h.stop();
  await new Promise((resolve) => osrm.close(resolve));
});

const vendorApi = (method, path, body) => h.api(method, `/vendor/special-deliveries${path}`, { token: caterTok, body });
let point = 0;

/** A customer with a deposit-paid event order, delivery agreed at 50,000 RWF. */
async function bookedAgreement() {
  point += 1;
  const venue = { address: 'Huye, Ngoma sector', latitude: -2.6 - point * 0.001, longitude: 29.74 };
  const body = {
    vendor_id: String(caterer._id),
    package_id: 'wedding1',
    guests: 100,
    fulfillment: 'delivery',
    delivery_location: venue,
    event_at: new Date(Date.now() + 10 * DAY_MS).toISOString(),
  };
  const { token } = await h.createCustomer();
  const req = await h.api('POST', '/special-deliveries', { token, body });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const id = req.body.id;
  await vendorApi('POST', `/${id}/accept-negotiation`, {});
  const q = await vendorApi('POST', `/${id}/quotations`, { fee_rwf: 50000, arrangements: ['rented_vehicle'], arrangement_description: 'Rented van' });
  await h.api('POST', `/special-deliveries/${id}/quotations/${q.body.active_quotation.id}/accept`, { token });
  const order = await h.api('POST', '/orders/event-checkout', { token, body: { ...body, ...h.MOBILE_MONEY, special_delivery_request_id: id } });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  return { token, requestId: id, order: order.body };
}

const dispute = (token, id) => h.api('POST', `/special-deliveries/${id}/dispute`, { token, body: { reason: 'Van arrived 3 hours late' } });
const resolve = (id, body) => specialDeliveryService.resolveDispute(null, id, body);
const books = async () => (await platformLedgerService.snapshot()).unreconciled_rwf;

test('a fee reduction comes off the unpaid balance first, then refunds only what was overpaid; books stay balanced', async () => {
  const { token, requestId, order } = await bookedAgreement();
  // 100 plates × 5,000 + 50,000 delivery = 550,000; half paid now.
  assert.equal(order.total_rwf, 550000);
  assert.equal(order.deposit.amount_paid_rwf, 275000);

  // 1. Balance still unpaid: the reduction lowers it, no cash moves.
  assert.equal((await dispute(token, requestId)).body.status, 'disputed');
  const first = await resolve(requestId, { outcome: 'delivery_confirmed', resolution: 'Late arrival: 20,000 off', fee_reduction_rwf: 20000 });
  assert.equal(first.current.status, 'delivery_confirmed');
  assert.equal(first.current.dispute.fee_reduced_by_rwf, 20000);
  assert.equal(first.current.dispute.refund_rwf, 0);
  assert.equal(first.current.refunds.length, 0);
  let stored = await models.Order.findById(order.id).lean();
  assert.equal(stored.delivery_fee_rwf, 30000);
  assert.equal(stored.total_rwf, 530000);
  assert.equal(stored.deposit.balance_rwf, 255000);
  assert.equal(stored.big_event_delivery.fee_rwf, 50000, 'the agreed price stays on record');
  assert.equal(stored.big_event_delivery.adjustments[0].reduced_by_rwf, 20000);

  // 2. Balance paid in full, then another dispute: now money goes back.
  const paid = await h.api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.payment.amount_rwf, 255000, 'the customer paid the lowered balance');
  const before = await books();
  await dispute(token, requestId);
  const second = await resolve(requestId, { outcome: 'delivery_confirmed', resolution: 'Missing tables: 10,000 back', fee_reduction_rwf: 10000 });
  assert.equal(second.current.dispute.refund_rwf, 10000);
  assert.equal(second.current.refunds.length, 1);
  assert.equal(second.current.refunds[0].kind, 'delivery_fee_adjustment');
  assert.equal(second.current.refunds[0].amount_rwf, 10000);
  stored = await models.Order.findById(order.id).lean();
  assert.equal(stored.payment_status, 'paid', 'a partial refund does not refund the order');
  assert.equal(stored.total_rwf, 520000);
  assert.equal(await books(), before, 'refund owed matches the money taken off the order');

  // One cash adjustment per order.
  await dispute(token, requestId);
  await assert.rejects(resolve(requestId, { outcome: 'delivery_confirmed', resolution: 'x', fee_reduction_rwf: 1000 }), { code: 'ALREADY_ADJUSTED' });
  await resolve(requestId, { outcome: 'delivery_confirmed', resolution: 'No further change' });

  // 3. Later cancelled: the cancellation refund is net of what was already refunded.
  const cancelled = await h.api('POST', `/orders/${order.id}/cancel`, { token, body: {} });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const refunds = await models.Refund.find({ order_id: order.id }).lean();
  assert.equal(refunds.length, 2);
  assert.equal(refunds.reduce((sum, r) => sum + r.amount_rwf, 0), 530000, 'everything paid comes back exactly once');
  assert.equal(refunds.find((r) => r.kind === 'order_cancelled').amount_rwf, 520000);
  assert.equal(await books(), before);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await h.api('GET', `/special-deliveries/${requestId}`, { token })).body.status, 'customer_cancelled');
});

test('resolving by cancelling cancels the order and refunds what was paid', async () => {
  const { token, requestId, order } = await bookedAgreement();
  await dispute(token, requestId);
  await assert.rejects(resolve(requestId, { outcome: 'customer_cancelled', resolution: 'x', fee_reduction_rwf: 5 }), { statusCode: 400 });
  const result = await resolve(requestId, { outcome: 'customer_cancelled', resolution: 'Kitchen could not deliver' });
  assert.equal(result.current.status, 'customer_cancelled');
  const stored = await models.Order.findById(order.id).lean();
  assert.equal(stored.status, 'cancelled');
  const refund = await models.Refund.findOne({ order_id: order.id }).lean();
  assert.equal(refund.kind, 'order_cancelled');
  assert.equal(refund.amount_rwf, 275000, 'the deposit paid');
});

test('the kitchen is not paid while a dispute is open; resolving releases its reduced payout', async () => {
  const { token, requestId, order } = await bookedAgreement();
  await h.api('POST', `/orders/${order.id}/pay-balance`, { token, body: {} });
  await dispute(token, requestId);
  const vendorBefore = (await models.Vendor.findById(caterer._id).lean()).available_balance;

  // Food handed over during the dispute: the money stays held.
  await adminOrderService.updateStatus(order.id, { status: 'delivered' }, null);
  let stored = await models.Order.findById(order.id).lean();
  assert.equal(stored.settlement_status, 'held');
  assert.equal((await h.api('GET', `/special-deliveries/${requestId}`, { token })).body.order.payout_on_hold, true);

  await assert.rejects(resolve(requestId, { outcome: 'completed', resolution: 'x', fee_reduction_rwf: 50001 }), { statusCode: 400 });
  await assert.rejects(resolve(requestId, { outcome: 'customer_cancelled', resolution: 'x' }), { code: 'ORDER_ALREADY_DELIVERED' });
  const done = await resolve(requestId, { outcome: 'completed', resolution: 'Late: 5,000 back', fee_reduction_rwf: 5000 });
  assert.equal(done.current.status, 'completed');
  stored = await models.Order.findById(order.id).lean();
  assert.equal(stored.settlement_status, 'settled');
  assert.equal(stored.vendor_payout_rwf, stored.subtotal_rwf - stored.commission_rwf + 45000, 'kitchen gets the reduced delivery fee');
  const vendorAfter = (await models.Vendor.findById(caterer._id).lean()).available_balance;
  assert.equal(vendorAfter - vendorBefore, stored.vendor_payout_rwf);
  const refund = await models.Refund.findOne({ order_id: order.id, kind: 'delivery_fee_adjustment' }).lean();
  assert.equal(refund.amount_rwf, 5000);
});

test('no refund for an order whose money is not held', async () => {
  const { token, requestId, order } = await bookedAgreement();
  await dispute(token, requestId);
  await models.Order.updateOne({ _id: order.id }, { $set: { payment_status: 'pending' } });
  await assert.rejects(resolve(requestId, { outcome: 'delivery_confirmed', resolution: 'x', fee_reduction_rwf: 1000 }), { code: 'REFUND_NOT_POSSIBLE' });
});

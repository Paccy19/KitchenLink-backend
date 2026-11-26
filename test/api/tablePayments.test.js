process.env.AGENT_API_KEY ||= 'test-agent-key-that-is-long-enough-to-be-secure';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, createKitchen } = require('../helpers/testServer');
const config = require('../../src/config');
const paypackService = require('../../src/services/paypackService');
const { signToken } = require('../../src/utils/jwt');
const { Invoice, Order, Payment, TableSession } = require('../../src/models');

let kitchen;
let ownerToken;
let cashin;
let transactionStatus;

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};

async function createTable(label, prices) {
  const table = ok(await api('POST', '/vendor/tables', {
    token: ownerToken,
    body: { label, capacity: prices.length },
  }), 201);
  const seats = [];
  for (let index = 0; index < prices.length; index += 1) {
    const token = table.seats[index].token;
    const session = ok(await api('POST', `/tables/${token}/session`, { body: {} }), 201);
    const item = kitchen.items.find((entry) => entry.price_rwf === prices[index]);
    assert.ok(item, `test fixture has a ${prices[index]} RWF item`);
    const placed = ok(await api('POST', `/tables/${token}/orders`, {
      headers: { 'x-dining-session-key': session.session_key },
      body: { items: [{ menu_item_id: String(item._id), quantity: 1 }] },
    }), 201);
    seats.push({ token, session, order: placed.order, guestKey: placed.guest_key });
  }
  return { table, seats };
}

const sessionHeaders = (seat) => ({ 'x-dining-session-key': seat.session.session_key });
const getPaymentSeats = (seat) => api('GET', `/tables/${seat.token}/payment-seats`, { headers: sessionHeaders(seat) });
const postAuthorization = (seat) => api('POST', `/tables/${seat.token}/payment-authorizations`, { headers: sessionHeaders(seat), body: {} });
const joinAuthorization = (seat, code) => api('POST', `/tables/${seat.token}/payment-authorizations/join`, { headers: sessionHeaders(seat), body: { code } });
const selectSeat = (seat, amount, version) => ({
  customer_session_id: seat.session.customer_session_id,
  amount_rwf: amount,
  balance_version: version,
});

before(async () => {
  await start();
  kitchen = await createKitchen({
    name: 'Seat Payment Kitchen',
    dishes: [
      { name: 'Seat one meal', price_rwf: 180 },
      { name: 'Seat two meal', price_rwf: 120 },
      { name: 'Seat three meal', price_rwf: 95 },
      { name: 'Seat four meal', price_rwf: 150 },
      { name: 'Small meal', price_rwf: 200 },
      { name: 'Medium meal', price_rwf: 150 },
    ],
  });
  ownerToken = signToken({ sub: String(kitchen.vendor._id), role: 'vendor' });
  cashin = paypackService.cashin;
  transactionStatus = paypackService.transactionStatus;
});

after(async () => {
  paypackService.cashin = cashin;
  paypackService.transactionStatus = transactionStatus;
  await stop();
});

test('explicit consent, multi-seat partial allocation, retries, and unrelated seat isolation', async () => {
  const { table, seats } = await createTable('Four payer seats', [180, 120, 95, 150]);
  const [payer, second, third, fourth] = seats;

  let visible = ok(await getPaymentSeats(payer));
  assert.deepEqual(visible.seats.map((seat) => seat.seat_number), [1]);
  assert.equal(visible.seats[0].balance_rwf, 180);
  assert.equal('guest_name' in visible.seats[0], false);

  const denied = await api('POST', `/tables/${payer.token}/payments`, {
    headers: sessionHeaders(payer),
    body: {
      idempotency_key: 'unauthorized-attempt-0001',
      payment_details: { phone: '+250781234567' },
      seats: [selectSeat(second, 120, '0'.repeat(64))],
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PAYMENT_AUTHORIZATION_REQUIRED');

  const secondGrant = ok(await postAuthorization(second), 201);
  const thirdGrant = ok(await postAuthorization(third), 201);
  ok(await joinAuthorization(payer, secondGrant.code));
  ok(await joinAuthorization(payer, thirdGrant.code));
  visible = ok(await getPaymentSeats(payer));
  assert.deepEqual(visible.seats.map((seat) => seat.seat_number), [1, 2, 3]);
  assert.deepEqual(visible.seats.map((seat) => seat.balance_rwf), [180, 120, 95]);

  const selected = [
    selectSeat(payer, 180, visible.seats[0].balance_version),
    selectSeat(second, 120, visible.seats[1].balance_version),
    selectSeat(third, 95, visible.seats[2].balance_version),
  ];
  const body = {
    idempotency_key: 'four-seat-payment-attempt-01',
    payment_details: { phone: '+250781234567' },
    seats: selected,
  };
  const originalSimulated = config.payments.simulated;
  let calls = 0;
  config.payments.simulated = false;
  paypackService.cashin = async ({ amountRwf }) => {
    calls += 1;
    assert.equal(amountRwf, 395);
    return { reference: 'test-seat-combined-395', status: 'successful' };
  };
  try {
    const payment = ok(await api('POST', `/tables/${payer.token}/payments`, {
      headers: sessionHeaders(payer),
      body,
    }), 201);
    assert.equal(payment.status, 'successful');
    assert.equal(payment.amount_rwf, 395);
    assert.deepEqual(payment.allocations, [
      { seat_number: 1, amount_rwf: 180 },
      { seat_number: 2, amount_rwf: 120 },
      { seat_number: 3, amount_rwf: 95 },
    ]);

    const retry = ok(await api('POST', `/tables/${payer.token}/payments`, {
      headers: sessionHeaders(payer),
      body,
    }), 201);
    assert.equal(retry.reference, payment.reference);
    assert.equal(calls, 1, 'same idempotency key does not start another provider request');
    const changed = await api('POST', `/tables/${payer.token}/payments`, {
      headers: sessionHeaders(payer),
      body: { ...body, seats: [{ ...selected[0], amount_rwf: 179 }, ...selected.slice(1)] },
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

    await tablePaymentServiceDuplicateCallback(payment.reference);
    const updatedOrders = await Promise.all(seats.map((seat) => Order.findById(seat.order.id).lean()));
    assert.deepEqual(updatedOrders.map((order) => order.payment_status), ['paid', 'paid', 'paid', 'pending']);
    const invoice = await Invoice.findById(updatedOrders[0].invoice_id).lean();
    assert.equal(invoice.amount_paid_rwf, 395);
    assert.equal(invoice.status, 'partially_paid');
    assert.equal(invoice.is_open, true);
    const tableSession = await TableSession.findById(payer.session.table_session_id).lean();
    assert.equal(tableSession.status, 'active');

    const fourthGrant = ok(await postAuthorization(fourth), 201);
    ok(await joinAuthorization(payer, fourthGrant.code));
    visible = ok(await getPaymentSeats(payer));
    const fourthBalance = visible.seats.find((seat) => seat.seat_number === 4);
    const partialBody = {
      idempotency_key: 'fourth-seat-part-payment-01',
      payment_details: { phone: '+250781234567' },
      seats: [selectSeat(fourth, 70, fourthBalance.balance_version)],
    };
    paypackService.cashin = async ({ amountRwf }) => {
      calls += 1;
      assert.equal(amountRwf, 70);
      return { reference: 'test-seat-partial-70', status: 'successful' };
    };
    const partial = ok(await api('POST', `/tables/${payer.token}/payments`, {
      headers: sessionHeaders(payer),
      body: partialBody,
    }), 201);
    assert.equal(partial.status, 'successful');
    const fourthOrder = await Order.findById(fourth.order.id).lean();
    assert.equal(fourthOrder.payment_status, 'pending');
    assert.equal(fourthOrder.amount_paid_rwf, 70);
    const fourthBill = ok(await api('GET', `/tables/${fourth.token}/orders/${fourth.order.id}`, {
      headers: { 'x-guest-key': fourth.guestKey },
    }));
    assert.equal(fourthBill.order.bill.amount_paid_rwf, 70);
    assert.equal(fourthBill.order.bill.balance_due_rwf, 80);

    const finalInvoice = await Invoice.findById(fourthOrder.invoice_id).lean();
    assert.equal(finalInvoice.amount_paid_rwf, 465);
    assert.equal(finalInvoice.status, 'partially_paid');
  } finally {
    config.payments.simulated = originalSimulated;
  }
});

test('staff can record an idempotent payment allocated to selected seat balances', async () => {
  const { table, seats } = await createTable('Cashier seat payment', [200, 150]);
  const balanceResponse = ok(await api('GET', `/vendor/tables/${table.id}/seat-balances`, { token: ownerToken }));
  const seat = balanceResponse.seats.find((entry) => entry.seat_number === 1);
  const body = {
    idempotency_key: 'cashier-seat-payment-attempt-01',
    method: 'cash',
    reference: 'CASH-RECEIPT-91',
    seats: [selectSeat(seats[0], 200, seat.balance_version)],
  };
  const payment = ok(await api('POST', `/vendor/tables/${table.id}/seat-payments`, {
    token: ownerToken,
    body,
  }));
  assert.equal(payment.status, 'successful');
  assert.deepEqual(payment.allocations, [{ seat_number: 1, amount_rwf: 200 }]);
  const retry = ok(await api('POST', `/vendor/tables/${table.id}/seat-payments`, {
    token: ownerToken,
    body,
  }));
  assert.equal(retry.reference, payment.reference);
  const invoice = await Invoice.findOne({ table_id: table.id }).lean();
  assert.equal(invoice.amount_paid_rwf, 200);
  assert.equal(invoice.payments[0].channel, 'in_person');
  assert.ok(invoice.payments[0].payment_id);
  const unsupportedRefund = await api('POST', `/vendor/invoices/${invoice._id}/refunds`, {
    token: ownerToken,
    body: { amount_rwf: 50, reason: 'Seat allocation refund is not supported' },
  });
  assert.equal(unsupportedRefund.status, 409);
  assert.equal(unsupportedRefund.body.error.code, 'SEAT_PAYMENT_REFUND_UNSUPPORTED');
  const orders = await Order.find({ table_session_id: seats[0].session.table_session_id }).sort({ 'table.seat_number': 1 }).lean();
  assert.deepEqual(orders.map((order) => order.payment_status), ['paid', 'pending']);
});

test('a seat can revoke a consumed payment authorization', async () => {
  const { seats } = await createTable('Revoked consent', [180, 120]);
  const [payer, beneficiary] = seats;
  const grant = ok(await postAuthorization(beneficiary), 201);
  ok(await joinAuthorization(payer, grant.code));
  const before = ok(await getPaymentSeats(payer));
  assert.deepEqual(before.seats.map((seat) => seat.seat_number), [1, 2]);

  const revoked = ok(await api(
    'DELETE',
    `/tables/${beneficiary.token}/payment-authorizations/${grant.authorization_id}`,
    { headers: sessionHeaders(beneficiary) }
  ));
  assert.equal(revoked.status, 'revoked');
  const after = ok(await getPaymentSeats(payer));
  assert.deepEqual(after.seats.map((seat) => seat.seat_number), [1]);

  const denied = await api('POST', `/tables/${payer.token}/payments`, {
    headers: sessionHeaders(payer),
    body: {
      idempotency_key: 'revoked-consent-attempt-01',
      payment_details: { phone: '+250781234567' },
      seats: [selectSeat(beneficiary, 120, before.seats[1].balance_version)],
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PAYMENT_AUTHORIZATION_REQUIRED');
});

test('pending and failed provider states do not settle seats before verification', async () => {
  const { seats } = await createTable('Provider states', [200]);
  const [payer] = seats;
  const visible = ok(await getPaymentSeats(payer));
  const body = {
    idempotency_key: 'pending-seat-payment-attempt-01',
    payment_details: { phone: '+250781234567' },
    seats: [selectSeat(payer, 200, visible.seats[0].balance_version)],
  };
  const originalSimulated = config.payments.simulated;
  config.payments.simulated = false;
  paypackService.cashin = async () => ({ reference: 'test-seat-pending-failure', status: 'processing' });
  paypackService.transactionStatus = async () => 'failed';
  try {
    const pending = ok(await api('POST', `/tables/${payer.token}/payments`, {
      headers: sessionHeaders(payer),
      body,
    }), 201);
    assert.equal(pending.status, 'processing');
    const orderBeforeCheck = await Order.findById(payer.order.id).lean();
    assert.equal(orderBeforeCheck.payment_status, 'pending');
    assert.ok(orderBeforeCheck.payment_lock_id);
    const orderDuringPayment = await api('POST', `/tables/${payer.token}/orders`, {
      headers: sessionHeaders(payer),
      body: { items: [{ menu_item_id: String(kitchen.items[0]._id), quantity: 1 }] },
    });
    assert.equal(orderDuringPayment.status, 409);
    assert.equal(orderDuringPayment.body.error.code, 'SEAT_PAYMENT_PENDING');

    const failed = ok(await api('POST', `/tables/${payer.token}/payments/${pending.id}/check`, {
      headers: sessionHeaders(payer),
      body: {},
    }));
    assert.equal(failed.status, 'failed');
    const orderAfterCheck = await Order.findById(payer.order.id).lean();
    assert.equal(orderAfterCheck.payment_status, 'pending');
    assert.equal(orderAfterCheck.payment_lock_id, null);
    const refreshed = ok(await getPaymentSeats(payer));
    assert.equal(refreshed.seats[0].balance_rwf, 200);
  } finally {
    config.payments.simulated = originalSimulated;
  }
});

async function tablePaymentServiceDuplicateCallback(reference) {
  const service = require('../../src/services/kitchen/tablePaymentService');
  const payment = await Payment.findOne({ reference }).lean();
  assert.ok(payment?.provider_reference);
  assert.equal(await service.settleProviderPayment(payment.provider_reference, 'successful'), true);
  assert.equal(await service.settleProviderPayment(payment.provider_reference, 'successful'), true);
  const savedPayment = await Payment.findById(payment._id).lean();
  assert.equal(savedPayment.allocation_status, 'allocated');
  const invoice = await Invoice.findOne({ 'payments.payment_id': payment._id }).lean();
  assert.equal(invoice.payments.filter((entry) => String(entry.payment_id) === String(payment._id)).length, 1);
}

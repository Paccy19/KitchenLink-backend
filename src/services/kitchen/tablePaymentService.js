const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { parsePaymentDetails } = require('../../utils/validators');
const { DiningTable, Invoice, Order, Payment, TableSession, Vendor } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const paypackService = require('../paypackService');
const tableService = require('./tableService');
const diningSessionService = require('./diningSessionService');
const activity = require('./activityService');

const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const MAX_SELECTED_SEATS = 20;
const IN_PERSON_METHODS = access.IN_PERSON_METHODS.map((method) => method.id);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const constantTimeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function serializedPayment(payment) {
  const amountsBySeat = new Map();
  for (const allocation of payment.allocations || []) {
    amountsBySeat.set(
      allocation.seat_number,
      (amountsBySeat.get(allocation.seat_number) || 0) + allocation.amount_rwf
    );
  }
  return {
    id: String(payment._id),
    reference: payment.reference,
    status: payment.status,
    amount_rwf: payment.amount_rwf,
    failure_reason: payment.failure_reason || null,
    allocations: [...amountsBySeat.entries()].map(([seat_number, amount_rwf]) => ({ seat_number, amount_rwf })),
    created_at: payment.created_at,
    paid_at: payment.paid_at || null,
  };
}

function invoiceDiscounts(invoice) {
  const allocations = new Map();
  for (const entry of invoice.discount_allocations || []) {
    const key = String(entry.order_id);
    allocations.set(key, (allocations.get(key) || 0) + entry.amount_rwf);
  }
  const allocated = [...allocations.values()].reduce((sum, amount) => sum + amount, 0);
  const valid = invoice.discount_rwf === 0 || (
    (invoice.discount_allocations || []).length > 0 &&
    allocated === invoice.discount_rwf
  );
  return { allocations, valid };
}

function orderLinesTotal(invoice, orderId) {
  return (invoice.lines || []).reduce((sum, line) => (
    !line.voided && String(line.order_id) === String(orderId) ? sum + line.subtotal_rwf : sum
  ), 0);
}

function orderVersion(order, invoice, discount) {
  return hash(JSON.stringify({
    order_id: String(order._id),
    invoice_id: String(invoice._id),
    customer_session_id: String(order.customer_session_id),
    total_rwf: order.total_rwf,
    subtotal_rwf: order.subtotal_rwf,
    payment_status: order.payment_status,
    items: (order.items || []).map((item) => ({
      menu_item_id: item.menu_item_id ? String(item.menu_item_id) : null,
      quantity: item.quantity,
      subtotal_rwf: item.subtotal_rwf,
      price_rwf: item.price_rwf,
    })),
    invoice_discount_rwf: discount,
    invoice_order_subtotal_rwf: orderLinesTotal(invoice, order._id),
  }));
}

class TablePaymentService {
  async #resolve(token, customer, sessionKey) {
    const table = await tableService.findByToken(token);
    if (!table) throw ApiError.notFound('This QR code is not linked to a table any more.', 'TABLE_NOT_FOUND');
    if (!table._qr_seat_number) {
      throw ApiError.conflict('Use your individual seat QR code to access seat payments.', 'SEAT_QR_REQUIRED');
    }
    const vendor = await Vendor.findOne({ _id: table.vendor_id, deleted_at: null }).lean();
    if (!vendor || !vendor.is_active || vendor.verification_status !== 'approved') {
      throw ApiError.notFound('This kitchen is not available on KitchenLink right now.', 'VENDOR_UNAVAILABLE');
    }
    const owned = await diningSessionService.requireOwned(table, customer, sessionKey);
    return { table, vendor, ...owned };
  }

  #activeCustomerSession(tableSession, customerSessionId, now = new Date()) {
    if (!mongoose.isValidObjectId(customerSessionId)) return null;
    return (tableSession.customer_sessions || []).find((session) =>
      String(session._id) === String(customerSessionId) &&
      session.status === 'active' &&
      session.expires_at > now
    ) || null;
  }

  async createAuthorization(token, customer, sessionKey) {
    const { table, tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    const now = new Date();
    const authorizationId = new mongoose.Types.ObjectId();
    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Math.min(
      now.getTime() + AUTHORIZATION_TTL_MS,
      new Date(customerSession.expires_at).getTime()
    ));
    const authorization = {
      _id: authorizationId,
      beneficiary_customer_session_id: customerSession._id,
      payer_customer_session_id: null,
      token_hash: hash(code),
      status: 'pending',
      created_at: now,
      expires_at: expiresAt,
    };
    const saved = await TableSession.findOneAndUpdate(
      {
        _id: tableSession._id,
        status: 'active',
        customer_sessions: {
          $elemMatch: { _id: customerSession._id, status: 'active', expires_at: { $gt: now } },
        },
      },
      { $push: { payment_authorizations: authorization } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('Your seat session is no longer active.', 'DINING_SESSION_EXPIRED');
    return {
      authorization_id: String(authorizationId),
      code,
      seat_number: customerSession.seat_number,
      expires_at: expiresAt,
    };
  }

  async acceptAuthorization(token, customer, sessionKey, rawCode) {
    const { table, tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    if (typeof rawCode !== 'string' || rawCode.length < 24 || rawCode.length > 80) {
      throw ApiError.badRequest('Enter a valid payment authorization code.', { code: 'invalid' });
    }
    const now = new Date();
    const codeHash = hash(rawCode);
    const authorization = (tableSession.payment_authorizations || []).find((entry) =>
      entry.status === 'pending' &&
      entry.expires_at > now &&
      String(entry.beneficiary_customer_session_id) !== String(customerSession._id) &&
      constantTimeEqual(entry.token_hash, codeHash)
    );
    if (!authorization) {
      await TableSession.updateOne(
        {
          _id: tableSession._id,
          payment_authorizations: {
            $elemMatch: { status: 'pending', expires_at: { $lte: now } },
          },
        },
        { $set: { 'payment_authorizations.$[entry].status': 'expired' } },
        { arrayFilters: [{ 'entry.status': 'pending', 'entry.expires_at': { $lte: now } }] }
      );
      throw ApiError.notFound('That authorization code is invalid or has expired.', 'PAYMENT_AUTHORIZATION_NOT_FOUND');
    }
    if (!this.#activeCustomerSession(tableSession, authorization.beneficiary_customer_session_id, now)) {
      throw ApiError.conflict('The seat that granted permission is no longer active.', 'DINING_SESSION_EXPIRED');
    }
    const saved = await TableSession.findOneAndUpdate(
      {
        _id: tableSession._id,
        status: 'active',
        customer_sessions: {
          $elemMatch: { _id: customerSession._id, status: 'active', expires_at: { $gt: now } },
        },
        payment_authorizations: {
          $elemMatch: {
            _id: authorization._id,
            status: 'pending',
            token_hash: codeHash,
            expires_at: { $gt: now },
          },
        },
        $and: [
          {
            customer_sessions: {
              $elemMatch: {
                _id: authorization.beneficiary_customer_session_id,
                status: 'active',
                expires_at: { $gt: now },
              },
            },
          },
        ],
      },
      {
        $set: {
          'payment_authorizations.$.payer_customer_session_id': customerSession._id,
          'payment_authorizations.$.token_hash': null,
          'payment_authorizations.$.status': 'authorized',
          'payment_authorizations.$.authorized_at': now,
        },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This authorization was already used or revoked.', 'PAYMENT_AUTHORIZATION_USED');
    const beneficiary = this.#activeCustomerSession(saved, authorization.beneficiary_customer_session_id, now);
    return {
      authorization_id: String(authorization._id),
      status: 'authorized',
      seat_number: beneficiary.seat_number,
    };
  }

  async revokeAuthorization(token, customer, sessionKey, authorizationId) {
    const { table, tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    const id = parseObjectId(authorizationId, 'authorization_id');
    const activePayment = await Payment.exists({
      table_session_id: tableSession._id,
      status: { $in: ['processing', 'successful'] },
      allocation_status: { $ne: 'allocated' },
      'allocations.authorization_id': id,
    });
    if (activePayment) {
      throw ApiError.conflict('This permission is being used by a payment attempt and can no longer be revoked.', 'PAYMENT_AUTHORIZATION_IN_USE');
    }
    const result = await TableSession.updateOne(
      {
        _id: tableSession._id,
        payment_authorizations: {
          $elemMatch: {
            _id: id,
            beneficiary_customer_session_id: customerSession._id,
            status: { $in: ['pending', 'authorized'] },
          },
        },
      },
      {
        $set: {
          'payment_authorizations.$.status': 'revoked',
          'payment_authorizations.$.revoked_at': new Date(),
          'payment_authorizations.$.token_hash': null,
        },
      }
    );
    if (!result.modifiedCount) throw ApiError.notFound('Payment authorization not found.', 'PAYMENT_AUTHORIZATION_NOT_FOUND');
    return { authorization_id: String(id), status: 'revoked' };
  }

  async #seatBalances(tableSession, customerSessions, ownSessionId, ignorePaymentId = null) {
    const sessionIds = customerSessions.map((entry) => entry._id);
    const orders = await Order.find({
      table_session_id: tableSession._id,
      customer_session_id: { $in: sessionIds },
      fulfillment: 'dine_in',
      status: { $ne: 'cancelled' },
    }).sort({ created_at: 1, _id: 1 }).lean();
    const invoiceIds = [...new Set(orders.map((order) => String(order.invoice_id)).filter(Boolean))];
    const invoices = await Invoice.find({ _id: { $in: invoiceIds }, vendor_id: tableSession.vendor_id }).lean();
    const invoiceById = new Map(invoices.map((invoice) => [String(invoice._id), invoice]));
    const orderIds = orders.map((order) => order._id);
    const successfulPayments = await Payment.find({
      table_session_id: tableSession._id,
      status: 'successful',
      'allocations.order_id': { $in: orderIds },
    }).select('allocations reference paid_at payer_customer_session_id').lean();
    const paidByOrder = new Map();
    const paymentHistory = new Map();
    const sessionById = new Map((tableSession.customer_sessions || []).map((session) => [String(session._id), session]));
    for (const payment of successfulPayments) {
      for (const allocation of payment.allocations || []) {
        const key = String(allocation.order_id);
        paidByOrder.set(key, (paidByOrder.get(key) || 0) + allocation.amount_rwf);
        const seatKey = String(allocation.customer_session_id);
        const row = paymentHistory.get(seatKey) || [];
        let history = row.find((entry) => entry.reference === payment.reference);
        if (!history) {
          history = {
            reference: payment.reference,
            amount_rwf: 0,
            paid_at: payment.paid_at || null,
            payer_seat_number: sessionById.get(String(payment.payer_customer_session_id))?.seat_number ?? null,
          };
          row.push(history);
        }
        history.amount_rwf += allocation.amount_rwf;
        paymentHistory.set(seatKey, row);
      }
    }

    const orderRows = new Map();
    for (const order of orders) {
      const invoice = invoiceById.get(String(order.invoice_id));
      const session = customerSessions.find((entry) => String(entry._id) === String(order.customer_session_id));
      if (!invoice || invoice.kind !== 'table' || !session) {
        orderRows.set(String(order._id), { order, invoice, session, due: 0, paid: 0, error: 'legacy_reconciliation_required' });
        continue;
      }
      const discount = invoiceDiscounts(invoice);
      const discountForOrder = discount.allocations.get(String(order._id)) || 0;
      const gross = orderLinesTotal(invoice, order._id);
      const hasUnallocatedCash = (invoice.payments || []).some((payment) =>
        payment.channel !== 'online' && !payment.payment_id && payment.amount_rwf > 0
      );
      const hasUnallocatedOnline = (invoice.payments || []).some((payment) =>
        payment.channel === 'online' && !payment.payment_id && payment.amount_rwf > 0
      );
      const deliveryFeeUnsupported = (invoice.delivery_fee_rwf || 0) > 0;
      const invalidDiscount = !discount.valid || discountForOrder > gross;
      const error = hasUnallocatedCash || hasUnallocatedOnline || deliveryFeeUnsupported || invalidDiscount || gross <= 0
        ? 'legacy_reconciliation_required'
        : null;
      const total = Math.max(0, gross - discountForOrder);
      const paid = invoice.status === 'paid' || order.payment_status === 'paid'
        ? total
        : Math.min(total, paidByOrder.get(String(order._id)) || 0);
      const due = error ? 0 : Math.max(0, total - paid);
      orderRows.set(String(order._id), {
        order,
        invoice,
        session,
        gross,
        discount: discountForOrder,
        total,
        paid,
        due,
        error,
        version: orderVersion(order, invoice, discountForOrder),
        pending: Boolean(order.payment_lock_id && String(order.payment_lock_id) !== String(ignorePaymentId)),
      });
    }

    return customerSessions.map((session) => {
      const rows = orders
        .filter((order) => String(order.customer_session_id) === String(session._id))
        .map((order) => orderRows.get(String(order._id)));
      const outstanding = rows.reduce((sum, row) => sum + (row?.due || 0), 0);
      const paid = rows.reduce((sum, row) => sum + (row?.paid || 0), 0);
      const hasError = rows.some((row) => row?.error);
      const pending = rows.some((row) => row?.pending);
      const versionRows = rows.map((row) => ({
        order_id: String(row.order._id),
        due: row.due,
        paid: row.paid,
        version: row.version || 'legacy',
      }));
      const balanceVersion = hash(JSON.stringify(versionRows));
      return {
        customer_session_id: String(session._id),
        seat_number: session.seat_number,
        balance_rwf: outstanding,
        paid_rwf: paid,
        payment_status: hasError
          ? 'staff_reconciliation_required'
          : pending
            ? 'payment_pending'
            : outstanding === 0 && rows.length
              ? 'paid'
              : paid > 0
                ? 'partially_paid'
                : 'unpaid',
        payable: !hasError && !pending && outstanding > 0,
        balance_version: balanceVersion,
        orders: rows,
        payment_history: paymentHistory.get(String(session._id)) || [],
      };
    });
  }

  async payableSeats(token, customer, sessionKey) {
    const { tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    const now = new Date();
    const grants = (tableSession.payment_authorizations || []).filter((entry) =>
      entry.status === 'authorized' &&
      String(entry.payer_customer_session_id) === String(customerSession._id) &&
      entry.expires_at > now
    );
    const allowed = [customerSession];
    for (const grant of grants) {
      const beneficiary = this.#activeCustomerSession(tableSession, grant.beneficiary_customer_session_id, now);
      if (beneficiary && !allowed.some((entry) => String(entry._id) === String(beneficiary._id))) allowed.push(beneficiary);
    }
    const balances = await this.#seatBalances(tableSession, allowed, customerSession._id);
    return {
      table_session_id: String(tableSession._id),
      payer_customer_session_id: String(customerSession._id),
      seats: balances.map(({ customer_session_id, seat_number, balance_rwf, paid_rwf, payment_status, payable, balance_version }) => ({
        customer_session_id,
        seat_number,
        is_you: customer_session_id === String(customerSession._id),
        balance_rwf,
        paid_rwf,
        payment_status,
        payable,
        balance_version,
      })),
    };
  }

  #parseSelection(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SELECTED_SEATS) {
      throw ApiError.badRequest(`Select between 1 and ${MAX_SELECTED_SEATS} seats.`, { seats: 'invalid selection' });
    }
    const seen = new Set();
    return raw.map((entry, index) => {
      const customerSessionId = parseObjectId(entry?.customer_session_id, `seats[${index}].customer_session_id`);
      const key = String(customerSessionId);
      if (seen.has(key)) throw ApiError.badRequest('A seat can only be selected once.', { seats: 'duplicate seat' });
      seen.add(key);
      const amount = Number(entry?.amount_rwf);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) {
        throw ApiError.badRequest('Each seat amount must be a positive whole number of RWF.', { [`seats[${index}].amount_rwf`]: 'expected a positive integer' });
      }
      if (typeof entry?.balance_version !== 'string' || !/^[a-f0-9]{64}$/.test(entry.balance_version)) {
        throw ApiError.badRequest('Refresh the seat balances before paying.', { [`seats[${index}].balance_version`]: 'required' });
      }
      return { customer_session_id: customerSessionId, amount_rwf: amount, balance_version: entry.balance_version };
    });
  }

  async initiatePayment(token, customer, sessionKey, body = {}) {
    const { table, vendor, tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    const rawKey = body.idempotency_key;
    if (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(rawKey)) {
      throw ApiError.badRequest('A valid idempotency_key is required.', { idempotency_key: 'expected 16-128 safe characters' });
    }
    const selections = this.#parseSelection(body.seats);
    const details = parsePaymentDetails('mobile_money', body.payment_details);
    const idempotencyKeyHash = hash(rawKey);
    const requestHash = hash(JSON.stringify({
      method: 'mobile_money',
      phone: details.phone,
      seats: selections
        .map((entry) => [String(entry.customer_session_id), entry.amount_rwf, entry.balance_version])
        .sort((a, b) => a[0].localeCompare(b[0])),
    }));
    const previous = await Payment.findOne({
      payer_customer_session_id: customerSession._id,
      idempotency_key_hash: idempotencyKeyHash,
      table_session_id: tableSession._id,
    }).lean();
    if (previous) {
      if (previous.request_hash !== requestHash) {
        throw ApiError.conflict('This idempotency key was already used for different seats or payment details.', 'IDEMPOTENCY_KEY_REUSED');
      }
      if (previous.status === 'successful' && previous.allocation_status !== 'allocated') {
        await this.#allocateSuccessfulPayment(previous);
        return serializedPayment(await Payment.findById(previous._id).lean());
      }
      return serializedPayment(previous);
    }

    const now = new Date();
    const selectedSessions = [];
    const authorizationBySession = new Map();
    for (const selection of selections) {
      const selectedSession = this.#activeCustomerSession(tableSession, selection.customer_session_id, now);
      if (!selectedSession) throw ApiError.notFound('One of the selected seats is no longer active.', 'SEAT_SESSION_NOT_FOUND');
      if (String(selectedSession._id) !== String(customerSession._id)) {
        const grant = (tableSession.payment_authorizations || []).find((entry) =>
          entry.status === 'authorized' &&
          String(entry.payer_customer_session_id) === String(customerSession._id) &&
          String(entry.beneficiary_customer_session_id) === String(selectedSession._id) &&
          entry.expires_at > now
        );
        if (!grant) throw ApiError.forbidden('The customer in one selected seat has not authorized this payment.', 'PAYMENT_AUTHORIZATION_REQUIRED');
        authorizationBySession.set(String(selectedSession._id), grant._id);
      }
      selectedSessions.push(selectedSession);
    }

    const balances = await this.#seatBalances(tableSession, selectedSessions, customerSession._id);
    const balanceBySession = new Map(balances.map((balance) => [balance.customer_session_id, balance]));
    const planned = [];
    for (const selection of selections) {
      const balance = balanceBySession.get(String(selection.customer_session_id));
      if (!balance?.payable) {
        const code = balance?.payment_status === 'staff_reconciliation_required'
          ? 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED'
          : balance?.payment_status === 'payment_pending'
            ? 'SEAT_PAYMENT_PENDING'
            : 'SEAT_NOT_PAYABLE';
        throw ApiError.conflict('A selected seat cannot be paid right now. Refresh the balances and try again.', code);
      }
      if (!constantTimeEqual(balance.balance_version, selection.balance_version)) {
        throw ApiError.conflict('A selected seat balance changed. Review the updated breakdown before paying.', 'SEAT_BALANCE_CHANGED');
      }
      if (selection.amount_rwf > balance.balance_rwf) {
        throw ApiError.badRequest('A selected amount is more than that seat currently owes.', { amount_rwf: `at most ${balance.balance_rwf}` });
      }
      let remaining = selection.amount_rwf;
      for (const row of balance.orders) {
        if (row.due <= 0 || !row.invoice || !row.version) continue;
        const amount = Math.min(row.due, remaining);
        planned.push({
          order_id: row.order._id,
          invoice_id: row.invoice._id,
          customer_session_id: selection.customer_session_id,
          seat_number: balance.seat_number,
          amount_rwf: amount,
          authorization_id: authorizationBySession.get(String(selection.customer_session_id)) || null,
          balance_version: row.version,
        });
        remaining -= amount;
        if (!remaining) break;
      }
      if (remaining) throw ApiError.conflict('This seat balance needs staff reconciliation before it can be paid online.', 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED');
    }

    const total = planned.reduce((sum, entry) => sum + entry.amount_rwf, 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw ApiError.badRequest('The combined payment amount is invalid.');
    if (config.payments.simulated || !config.payments.enabledMethods.includes('mobile_money')) {
      throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', "Dine-in mobile-money payments aren't available until Paypack is configured.");
    }
    const reference = `SEAT-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    let payment;
    try {
      payment = await Payment.create({
        order_id: null,
        customer_id: customer?._id || null,
        vendor_id: vendor._id,
        table_id: table._id,
        table_session_id: tableSession._id,
        payer_customer_session_id: customerSession._id,
        idempotency_scope: `customer:${customerSession._id}`,
        idempotency_key_hash: idempotencyKeyHash,
        request_hash: requestHash,
        allocations: planned,
        allocation_status: 'pending',
        amount_rwf: total,
        method: 'mobile_money',
        provider: 'paypack',
        status: 'processing',
        reference,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const raced = await Payment.findOne({
        payer_customer_session_id: customerSession._id,
        idempotency_key_hash: idempotencyKeyHash,
        table_session_id: tableSession._id,
      }).lean();
      if (!raced) throw error;
      if (raced.request_hash !== requestHash) {
        throw ApiError.conflict('This idempotency key was already used for different seats or payment details.', 'IDEMPOTENCY_KEY_REUSED');
      }
      return serializedPayment(raced);
    }

    const orderIds = [...new Set(planned.map((entry) => String(entry.order_id)))];
    const reserved = await Order.updateMany(
      {
        _id: { $in: orderIds },
        vendor_id: vendor._id,
        table_session_id: tableSession._id,
        payment_status: { $ne: 'paid' },
        status: { $ne: 'cancelled' },
        payment_lock_id: null,
      },
      { $set: { payment_lock_id: payment._id, payment_lock_expires_at: null } }
    );
    const reservedCount = reserved.modifiedCount ?? reserved.nModified ?? 0;
    if (reservedCount !== orderIds.length) {
      await Order.updateMany({ payment_lock_id: payment._id }, { $set: { payment_lock_id: null, payment_lock_expires_at: null } });
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { status: 'failed', failure_reason: 'A selected seat is being paid by another attempt.' },
      });
      throw ApiError.conflict('A selected seat is being paid by another attempt. Refresh and try again.', 'SEAT_PAYMENT_PENDING');
    }

    const activeTableSession = await TableSession.findOne({
      _id: tableSession._id,
      status: 'active',
    }).lean();
    const livePayer = activeTableSession && this.#activeCustomerSession(activeTableSession, customerSession._id);
    const sessionsStillActive = activeTableSession && selectedSessions.every((selected) =>
      this.#activeCustomerSession(activeTableSession, selected._id)
    );
    const consentStillActive = selections.every((selection) => {
      if (String(selection.customer_session_id) === String(customerSession._id)) return true;
      return (activeTableSession?.payment_authorizations || []).some((grant) =>
        grant.status === 'authorized' &&
        String(grant.payer_customer_session_id) === String(customerSession._id) &&
        String(grant.beneficiary_customer_session_id) === String(selection.customer_session_id) &&
        grant.expires_at > new Date()
      );
    });
    if (!livePayer || !sessionsStillActive || !consentStillActive) {
      await Order.updateMany({ payment_lock_id: payment._id }, { $set: { payment_lock_id: null, payment_lock_expires_at: null } });
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { status: 'failed', failure_reason: 'Seat session or payment authorization ended before payment.' },
      });
      throw ApiError.conflict('A selected seat session or payment authorization ended. Refresh and try again.', 'PAYMENT_AUTHORIZATION_REQUIRED');
    }

    const currentBalances = await this.#seatBalances(tableSession, selectedSessions, customerSession._id, payment._id);
    const currentBySession = new Map(currentBalances.map((balance) => [balance.customer_session_id, balance]));
    const changed = selections.some((selection) => {
      const balance = currentBySession.get(String(selection.customer_session_id));
      return !balance || balance.balance_version !== selection.balance_version || selection.amount_rwf > balance.balance_rwf;
    });
    if (changed) {
      await Order.updateMany({ payment_lock_id: payment._id }, { $set: { payment_lock_id: null, payment_lock_expires_at: null } });
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { status: 'failed', failure_reason: 'Seat balance changed before payment initiation.' },
      });
      throw ApiError.conflict('A selected seat balance changed. Review the updated breakdown before paying.', 'SEAT_BALANCE_CHANGED');
    }

    let sent;
    try {
      sent = await paypackService.cashin({ amountRwf: total, phone: details.phone });
    } catch (error) {
      // The provider may have accepted a prompt before a network failure. Keep
      // the attempt and seat locks so a retry cannot create a duplicate charge.
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { failure_reason: 'Paypack response was unavailable; payment status must be verified before retrying.' },
      });
      console.error('[table-payments] Paypack initiation failed:', error.message);
      throw new ApiError(502, 'PAYMENT_STATUS_UNAVAILABLE', 'Paypack did not confirm the payment request. Check the payment status before trying again.');
    }
    if (!sent?.reference) {
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { failure_reason: 'Paypack returned no transaction reference; staff verification is required.' },
      });
      throw new ApiError(502, 'PAYMENT_REFERENCE_MISSING', 'Paypack did not return a transaction reference. Contact the cashier before retrying.');
    }
    await Payment.updateOne({ _id: payment._id, status: 'processing' }, { $set: { provider_reference: String(sent.reference) } });
    if (sent.status === 'successful' || sent.status === 'failed') {
      await this.settleProviderPayment(String(sent.reference), sent.status);
    }
    const latest = await Payment.findById(payment._id).lean();
    return serializedPayment(latest);
  }

  async checkPayment(token, customer, sessionKey, paymentId) {
    const { tableSession, customerSession } = await this.#resolve(token, customer, sessionKey);
    const id = parseObjectId(paymentId, 'payment_id');
    let payment = await Payment.findOne({
      _id: id,
      table_session_id: tableSession._id,
      payer_customer_session_id: customerSession._id,
    }).lean();
    if (!payment) throw ApiError.notFound('Payment attempt not found.', 'PAYMENT_NOT_FOUND');
    if (payment.status === 'processing' && payment.provider_reference) {
      const status = await paypackService.transactionStatus(payment.provider_reference);
      await this.settleProviderPayment(payment.provider_reference, status);
      payment = await Payment.findById(payment._id).lean();
    }
    return serializedPayment(payment);
  }

  async settleProviderPayment(providerReference, providerStatus) {
    const payment = await Payment.findOne({
      provider_reference: String(providerReference),
      table_session_id: { $ne: null },
    });
    if (!payment) return false;
    if (providerStatus === 'processing') return true;
    if (providerStatus === 'failed') {
      await Payment.updateOne(
        { _id: payment._id, status: { $in: ['processing', 'pending'] } },
        { $set: { status: 'failed', failure_reason: 'Paypack reported that this payment failed.' } }
      );
      await Order.updateMany(
        { payment_lock_id: payment._id },
        { $set: { payment_lock_id: null, payment_lock_expires_at: null } }
      );
      return true;
    }
    if (providerStatus !== 'successful') return true;
    await Payment.updateOne(
      { _id: payment._id, status: { $in: ['processing', 'pending'] } },
      { $set: { status: 'successful', paid_at: new Date(), failure_reason: '' } }
    );
    const current = await Payment.findById(payment._id).lean();
    if (current?.allocation_status !== 'allocated') await this.#allocateSuccessfulPayment(current);
    return true;
  }

  async #allocateSuccessfulPayment(payment) {
    if (!payment || payment.status !== 'successful') return;
    const orderIds = [...new Set((payment.allocations || []).map((entry) => String(entry.order_id)))];
    const orders = await Order.find({ _id: { $in: orderIds } }).lean();
    const invoices = await Invoice.find({
      _id: { $in: [...new Set(payment.allocations.map((entry) => String(entry.invoice_id)))] },
      vendor_id: payment.vendor_id,
    }).lean();
    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    const invoiceById = new Map(invoices.map((invoice) => [String(invoice._id), invoice]));
    const alreadyAppliedInvoices = new Set(
      invoices
        .filter((invoice) => (invoice.payments || []).some((entry) => String(entry.payment_id) === String(payment._id)))
        .map((invoice) => String(invoice._id))
    );
    for (const allocation of payment.allocations) {
      const order = orderById.get(String(allocation.order_id));
      const invoice = invoiceById.get(String(allocation.invoice_id));
      const discount = invoice && invoiceDiscounts(invoice);
      const discountForOrder = discount?.allocations.get(String(allocation.order_id)) || 0;
      if (
        !order || !invoice || !discount?.valid ||
        String(order.invoice_id) !== String(invoice._id) ||
        String(order.table_session_id) !== String(payment.table_session_id) ||
        String(order.customer_session_id) !== String(allocation.customer_session_id) ||
        order.status === 'cancelled' ||
        (orderVersion(order, invoice, discountForOrder) !== allocation.balance_version &&
          !alreadyAppliedInvoices.has(String(invoice._id)))
      ) {
        throw ApiError.conflict('A paid seat balance changed during provider processing. Staff reconciliation is required.', 'PAYMENT_REQUIRES_RECONCILIATION');
      }
    }

    const byInvoice = new Map();
    for (const allocation of payment.allocations) {
      const id = String(allocation.invoice_id);
      byInvoice.set(id, (byInvoice.get(id) || 0) + allocation.amount_rwf);
    }
    for (const [invoiceId, amount] of byInvoice.entries()) {
      const invoice = invoiceById.get(invoiceId);
      const alreadyApplied = (invoice.payments || []).some((entry) => String(entry.payment_id) === String(payment._id));
      if (alreadyApplied) continue;
      const updated = await Invoice.findOneAndUpdate(
        {
          _id: invoice._id,
          kind: 'table',
          status: { $in: ['unpaid', 'partially_paid'] },
          'payments.payment_id': { $ne: payment._id },
          $expr: { $lte: [{ $add: ['$amount_paid_rwf', amount] }, '$total_rwf'] },
        },
        {
          $inc: { amount_paid_rwf: amount },
          $push: {
            payments: {
              amount_rwf: amount,
              method: payment.method,
              reference: payment.reference,
              channel: payment.provider === 'cashier' ? 'in_person' : 'online',
              received_by: payment.received_by || { type: 'system', name: 'Paypack' },
              payment_id: payment._id,
              request_hash: payment.request_hash,
              at: payment.paid_at || new Date(),
            },
          },
        },
        { returnDocument: 'after' }
      ).lean();
      if (!updated) {
        const currentInvoice = await Invoice.findById(invoice._id).lean();
        if (!(currentInvoice?.payments || []).some((entry) => String(entry.payment_id) === String(payment._id))) {
          throw ApiError.conflict('The invoice changed before payment allocation. Staff reconciliation is required.', 'PAYMENT_REQUIRES_RECONCILIATION');
        }
      }
      await Invoice.updateOne(
        { _id: invoice._id, payments: { $elemMatch: { payment_id: payment._id } } },
        [
          {
            $set: {
              status: {
                $switch: {
                  branches: [
                    { case: { $and: [{ $gt: ['$total_rwf', 0] }, { $gte: ['$amount_paid_rwf', '$total_rwf'] }] }, then: 'paid' },
                    { case: { $gt: ['$amount_paid_rwf', 0] }, then: 'partially_paid' },
                  ],
                  default: 'unpaid',
                },
              },
            },
          },
          {
            $set: {
              paid_at: { $cond: [{ $and: [{ $eq: ['$status', 'paid'] }, { $eq: ['$paid_at', null] }] }, '$$NOW', '$paid_at'] },
              is_open: { $cond: [{ $eq: ['$status', 'paid'] }, false, '$is_open'] },
            },
          },
        ],
        { updatePipeline: true }
      );
    }

    for (const orderId of orderIds) {
      const order = orderById.get(orderId);
      const allocated = await Payment.aggregate([
        { $match: { table_session_id: payment.table_session_id, status: 'successful', 'allocations.order_id': order._id } },
        { $unwind: '$allocations' },
        { $match: { 'allocations.order_id': order._id } },
        { $group: { _id: null, amount_rwf: { $sum: '$allocations.amount_rwf' } } },
      ]);
      const invoice = invoiceById.get(String(order.invoice_id));
      const discount = invoiceDiscounts(invoice);
      const due = Math.max(0, orderLinesTotal(invoice, order._id) - (discount.allocations.get(String(order._id)) || 0));
      const paid = Math.min(due, allocated[0]?.amount_rwf || 0);
      const result = await Order.updateOne(
        {
          _id: order._id,
          payment_lock_id: payment._id,
          status: { $ne: 'cancelled' },
        },
        {
          $set: {
            payment_status: paid >= due ? 'paid' : 'pending',
            amount_paid_rwf: paid,
            payment_method: payment.provider === 'cashier' ? 'in_person' : payment.method,
            payment_lock_id: null,
            payment_lock_expires_at: null,
          },
        }
      );
      if (!(result.modifiedCount ?? result.nModified)) {
        const latest = await Order.findById(order._id).lean();
        if (!latest || (latest.amount_paid_rwf || 0) < paid) {
          throw ApiError.conflict('The order changed before payment allocation. Staff reconciliation is required.', 'PAYMENT_REQUIRES_RECONCILIATION');
        }
      }
    }
    await Payment.updateOne(
      { _id: payment._id, status: 'successful', allocation_status: { $ne: 'allocated' } },
      { $set: { allocation_status: 'allocated', allocated_at: new Date() } }
    );
  }

  async recordStaffPayment(kitchen, tableId, body = {}) {
    const tableObjectId = parseObjectId(tableId, 'table_id');
    const table = await DiningTable.findOne({
      _id: tableObjectId,
      vendor_id: kitchen.vendorId,
      deleted_at: null,
    }).lean();
    if (!table) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    const tableSession = await TableSession.findOne({
      vendor_id: kitchen.vendorId,
      table_id: table._id,
      status: 'active',
    }).lean();
    if (!tableSession) throw ApiError.conflict('This table has no active dining session.', 'TABLE_SESSION_NOT_ACTIVE');

    const rawKey = body.idempotency_key;
    if (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(rawKey)) {
      throw ApiError.badRequest('A valid idempotency_key is required.', { idempotency_key: 'expected 16-128 safe characters' });
    }
    const selections = this.#parseSelection(body.seats);
    const method = String(body.method || '');
    if (!IN_PERSON_METHODS.includes(method)) {
      throw ApiError.badRequest('Pick how the customer paid.', { method: `expected one of: ${IN_PERSON_METHODS.join(', ')}` });
    }
    const referenceText = parseOptionalText(body.reference, { field: 'reference', max: 80 }) || '';
    const idempotencyKeyHash = hash(rawKey);
    const idempotencyScope = `staff:${kitchen.vendorId}:${tableSession._id}`;
    const requestHash = hash(JSON.stringify({
      method,
      reference: referenceText,
      seats: selections
        .map((entry) => [String(entry.customer_session_id), entry.amount_rwf, entry.balance_version])
        .sort((a, b) => a[0].localeCompare(b[0])),
    }));
    const replay = async (payment) => {
      if (payment.request_hash !== requestHash) {
        throw ApiError.conflict('This idempotency key was already used for a different seat payment.', 'IDEMPOTENCY_KEY_REUSED');
      }
      if (payment.status === 'successful' && payment.allocation_status !== 'allocated') {
        await this.#allocateSuccessfulPayment(payment);
        payment = await Payment.findById(payment._id).lean();
      }
      return serializedPayment(payment);
    };
    const previous = await Payment.findOne({
      table_session_id: tableSession._id,
      idempotency_scope: idempotencyScope,
      idempotency_key_hash: idempotencyKeyHash,
    }).lean();
    if (previous) return replay(previous);

    const now = new Date();
    const selectedSessions = selections.map((entry) => this.#activeCustomerSession(tableSession, entry.customer_session_id, now));
    if (selectedSessions.some((entry) => !entry)) {
      throw ApiError.notFound('One of the selected seats is no longer active.', 'SEAT_SESSION_NOT_FOUND');
    }
    const balances = await this.#seatBalances(tableSession, selectedSessions, null);
    const balanceBySession = new Map(balances.map((balance) => [balance.customer_session_id, balance]));
    const planned = [];
    for (const selection of selections) {
      const balance = balanceBySession.get(String(selection.customer_session_id));
      if (!balance?.payable) {
        const code = balance?.payment_status === 'staff_reconciliation_required'
          ? 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED'
          : balance?.payment_status === 'payment_pending'
            ? 'SEAT_PAYMENT_PENDING'
            : 'SEAT_NOT_PAYABLE';
        throw ApiError.conflict('A selected seat cannot be paid right now. Refresh the balances and try again.', code);
      }
      if (balance.balance_version !== selection.balance_version) {
        throw ApiError.conflict('A selected seat balance changed. Refresh and confirm the amount again.', 'SEAT_BALANCE_CHANGED');
      }
      if (selection.amount_rwf > balance.balance_rwf) {
        throw ApiError.badRequest('A selected amount is more than that seat currently owes.', { amount_rwf: `at most ${balance.balance_rwf}` });
      }
      let remaining = selection.amount_rwf;
      for (const row of balance.orders) {
        if (row.due <= 0 || !row.invoice || !row.version) continue;
        const amount = Math.min(row.due, remaining);
        planned.push({
          order_id: row.order._id,
          invoice_id: row.invoice._id,
          customer_session_id: selection.customer_session_id,
          seat_number: balance.seat_number,
          amount_rwf: amount,
          authorization_id: null,
          balance_version: row.version,
        });
        remaining -= amount;
        if (!remaining) break;
      }
      if (remaining) throw ApiError.conflict('This seat needs staff reconciliation before it can be paid.', 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED');
    }
    const total = planned.reduce((sum, entry) => sum + entry.amount_rwf, 0);
    const reference = referenceText || `STAFF-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    let payment;
    try {
      payment = await Payment.create({
        vendor_id: kitchen.vendorId,
        table_id: table._id,
        table_session_id: tableSession._id,
        idempotency_scope: idempotencyScope,
        idempotency_key_hash: idempotencyKeyHash,
        request_hash: requestHash,
        allocations: planned,
        allocation_status: 'pending',
        amount_rwf: total,
        method,
        provider: 'cashier',
        status: 'processing',
        reference,
        received_by: kitchen.actor,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const raced = await Payment.findOne({
        table_session_id: tableSession._id,
        idempotency_scope: idempotencyScope,
        idempotency_key_hash: idempotencyKeyHash,
      }).lean();
      if (!raced) throw error;
      return replay(raced);
    }

    const orderIds = [...new Set(planned.map((entry) => String(entry.order_id)))];
    const reserved = await Order.updateMany(
      {
        _id: { $in: orderIds },
        vendor_id: kitchen.vendorId,
        table_session_id: tableSession._id,
        payment_status: { $ne: 'paid' },
        status: { $ne: 'cancelled' },
        payment_lock_id: null,
      },
      { $set: { payment_lock_id: payment._id, payment_lock_expires_at: null } }
    );
    const reservedCount = reserved.modifiedCount ?? reserved.nModified ?? 0;
    if (reservedCount !== orderIds.length) {
      await Order.updateMany({ payment_lock_id: payment._id }, { $set: { payment_lock_id: null, payment_lock_expires_at: null } });
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { status: 'failed', failure_reason: 'A selected seat is being paid by another attempt.' },
      });
      throw ApiError.conflict('A selected seat is being paid by another attempt. Refresh and try again.', 'SEAT_PAYMENT_PENDING');
    }
    const currentTableSession = await TableSession.findOne({ _id: tableSession._id, status: 'active' }).lean();
    const latestSessions = selectedSessions.map((entry) =>
      currentTableSession && this.#activeCustomerSession(currentTableSession, entry._id)
    );
    const currentBalances = await this.#seatBalances(tableSession, selectedSessions, null, payment._id);
    const currentBySession = new Map(currentBalances.map((balance) => [balance.customer_session_id, balance]));
    const changed = latestSessions.some((entry) => !entry) || selections.some((selection) => {
      const balance = currentBySession.get(String(selection.customer_session_id));
      return !balance || balance.balance_version !== selection.balance_version || selection.amount_rwf > balance.balance_rwf;
    });
    if (changed) {
      await Order.updateMany({ payment_lock_id: payment._id }, { $set: { payment_lock_id: null, payment_lock_expires_at: null } });
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, {
        $set: { status: 'failed', failure_reason: 'Seat balance changed before recording payment.' },
      });
      throw ApiError.conflict('A selected seat balance changed. Refresh and confirm the amount again.', 'SEAT_BALANCE_CHANGED');
    }

    await Payment.updateOne({ _id: payment._id, status: 'processing' }, { $set: { status: 'successful', paid_at: new Date() } });
    await this.#allocateSuccessfulPayment(await Payment.findById(payment._id).lean());
    await activity.record(kitchen, {
      action: 'invoice.seat_payment',
      target_type: 'table_session',
      target_id: tableSession._id,
      summary: `Recorded RWF ${total.toLocaleString('en-US')} across selected seats`,
      details: {
        reference,
        method,
        allocations: planned.map(({ seat_number, amount_rwf }) => ({ seat_number, amount_rwf })),
      },
    });
    return serializedPayment(await Payment.findById(payment._id).lean());
  }

  async staffSeatBalances(kitchen, tableId) {
    const id = parseObjectId(tableId, 'table_id');
    const table = await DiningTable.findOne({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    const tableSession = await TableSession.findOne({
      vendor_id: kitchen.vendorId,
      table_id: table._id,
      status: 'active',
    }).lean();
    if (!tableSession) return { table_id: String(table._id), table_session_id: null, seats: [] };
    const sessions = (tableSession.customer_sessions || []).filter((entry) =>
      entry.status === 'active' && entry.expires_at > new Date()
    );
    const balances = await this.#seatBalances(tableSession, sessions, null);
    return {
      table_id: String(table._id),
      table_session_id: String(tableSession._id),
      seats: balances.map((balance) => ({
        customer_session_id: balance.customer_session_id,
        seat_number: balance.seat_number,
        balance_rwf: balance.balance_rwf,
        paid_rwf: balance.paid_rwf,
        balance_version: balance.balance_version,
        payment_status: balance.payment_status,
        payable: balance.payable,
        payment_history: balance.payment_history,
        orders: balance.orders.map((row) => ({
          order_number: row.order.order_number,
          status: row.order.status,
          payment_status: row.order.payment_status,
          total_rwf: row.order.total_rwf,
        })),
      })),
    };
  }
}

module.exports = new TablePaymentService();

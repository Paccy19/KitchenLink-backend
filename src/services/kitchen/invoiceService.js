const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { Invoice, Order, Vendor, Counter } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const OPEN = ['unpaid', 'partially_paid'];
const METHOD_IDS = access.IN_PERSON_METHODS.map((m) => m.id);
const methodLabel = (id) =>
  access.IN_PERSON_METHODS.find((m) => m.id === id)?.label ||
  config.orders.paymentMethods.find((m) => m.code === id)?.label ||
  id;

const nextNumber = async (vendorId) => `INV-${String(await Counter.next(`invoice:${vendorId}`)).padStart(5, '0')}`;

const linesFrom = (order) =>
  (order.items || []).map((item) => ({
    order_id: order._id,
    order_number: order.order_number,
    item_id: item._id || null,
    name: item.name,
    department_id: item.department_id || null,
    department_name: item.department_name || '',
    quantity: item.quantity,
    unit_price_rwf: item.quantity ? Math.round(item.subtotal_rwf / item.quantity) : item.price_rwf,
    subtotal_rwf: item.subtotal_rwf,
    voided: order.status === 'cancelled',
  }));

/**
 * Works the totals and status out again from the invoice itself, in one
 * atomic update (so two cashiers, or a payment and a new order, can't leave
 * it inconsistent).
 */
const recalc = (invoiceId) =>
  Invoice.findOneAndUpdate(
    { _id: invoiceId },
    [
      {
        $set: {
          subtotal_rwf: {
            $sum: {
              $map: {
                input: { $filter: { input: '$lines', as: 'l', cond: { $ne: ['$$l.voided', true] } } },
                as: 'l',
                in: '$$l.subtotal_rwf',
              },
            },
          },
        },
      },
      { $set: { total_rwf: { $max: [0, { $subtract: [{ $add: ['$subtotal_rwf', '$delivery_fee_rwf'] }, '$discount_rwf'] }] } } },
      {
        $set: {
          status: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'void'] }, then: 'void' },
                { case: { $and: [{ $gt: ['$amount_paid_rwf', 0] }, { $gte: ['$refunded_rwf', '$amount_paid_rwf'] }] }, then: 'refunded' },
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
          // A fully paid bill takes no more orders from the table.
          is_open: { $cond: [{ $in: ['$status', ['paid', 'refunded', 'void']] }, false, '$is_open'] },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true }
  ).lean();

/** The bill is paid in full: its dine-in orders count as paid. */
async function markOrdersPaid(invoice) {
  if (invoice.status !== 'paid') return;
  const orders = await Order.find({ _id: { $in: invoice.order_ids }, payment_method: 'in_person', payment_status: 'pending' })
    .select('_id total_rwf')
    .lean();
  await Promise.all(
    orders.map((order) =>
      Order.updateOne({ _id: order._id, payment_status: 'pending' }, { $set: { payment_status: 'paid', amount_paid_rwf: order.total_rwf } })
    )
  );
}

function serialize(invoice, { vendor = null, detail = false } = {}) {
  const live = (invoice.lines || []).filter((l) => !l.voided);
  const byDepartment = new Map();
  for (const line of live) {
    const key = line.department_id ? String(line.department_id) : 'main';
    const entry = byDepartment.get(key) || { department_id: line.department_id ? String(line.department_id) : null, department_name: line.department_name || 'Kitchen', subtotal_rwf: 0, items: 0 };
    entry.subtotal_rwf += line.subtotal_rwf;
    entry.items += line.quantity;
    byDepartment.set(key, entry);
  }
  const inPersonPaid = (invoice.payments || []).filter((p) => p.channel === 'in_person').reduce((sum, p) => sum + p.amount_rwf, 0);
  const base = {
    id: String(invoice._id),
    invoice_number: invoice.invoice_number,
    kind: invoice.kind,
    status: invoice.status,
    is_open: Boolean(invoice.is_open),
    table: invoice.table_id ? { id: String(invoice.table_id), label: invoice.table_label } : null,
    customer_name: invoice.customer_name || '',
    order_ids: (invoice.order_ids || []).map(String),
    subtotal_rwf: invoice.subtotal_rwf,
    delivery_fee_rwf: invoice.delivery_fee_rwf || 0,
    discount_rwf: invoice.discount_rwf || 0,
    total_rwf: invoice.total_rwf,
    amount_paid_rwf: invoice.amount_paid_rwf,
    refunded_rwf: invoice.refunded_rwf || 0,
    balance_due_rwf: Math.max(0, invoice.total_rwf - invoice.amount_paid_rwf),
    // Only money the kitchen took itself can be refunded here (online payments go through KitchenLink).
    refundable_rwf: Math.max(0, inPersonPaid - (invoice.refunded_rwf || 0)),
    accepts_payments: invoice.kind === 'table' && OPEN.includes(invoice.status),
    created_at: invoice.created_at,
    paid_at: invoice.paid_at ?? null,
    closed_at: invoice.closed_at ?? null,
  };
  if (!detail) return { ...base, line_count: live.length };
  return {
    ...base,
    notes: invoice.notes || '',
    lines: (invoice.lines || []).map((line) => ({
      id: String(line._id),
      order_id: line.order_id ? String(line.order_id) : null,
      order_number: line.order_number,
      name: line.name,
      department_id: line.department_id ? String(line.department_id) : null,
      department_name: line.department_name || 'Kitchen',
      quantity: line.quantity,
      unit_price_rwf: line.unit_price_rwf,
      subtotal_rwf: line.subtotal_rwf,
      voided: Boolean(line.voided),
    })),
    departments: [...byDepartment.values()],
    payments: (invoice.payments || []).map((p) => ({
      id: String(p._id),
      amount_rwf: p.amount_rwf,
      method: p.method,
      method_label: methodLabel(p.method),
      channel: p.channel,
      reference: p.reference || '',
      received_by: p.received_by?.name || '',
      at: p.at,
    })),
    refunds: (invoice.refunds || []).map((r) => ({
      id: String(r._id),
      amount_rwf: r.amount_rwf,
      method: r.method,
      method_label: methodLabel(r.method),
      reason: r.reason || '',
      by: r.by?.name || '',
      at: r.at,
    })),
    kitchen: vendor
      ? {
          name: vendor.name,
          phone: vendor.phone || null,
          email: vendor.email || null,
          address: [vendor.address, vendor.neighborhood].filter(Boolean).join(', '),
        }
      : null,
  };
}

const parseAmount = (raw, field = 'amount_rwf') => {
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) {
    throw ApiError.badRequest(`${field} must be a whole number of RWF above 0.`, { [field]: 'expected a positive integer' });
  }
  return amount;
};

class InvoiceService {
  /**
   * The invoice of one marketplace order (delivery or takeaway, paid online).
   * Created once, when the order is paid; calling it again returns the same one.
   */
  async ensureForOrder(orderId) {
    const order = await Order.findById(orderId).lean();
    if (!order || order.fulfillment === 'dine_in') return null;
    if (order.invoice_id) return Invoice.findById(order.invoice_id).lean();
    const invoiceId = new ObjectId();
    // Claim the order first: a second call (webhook and poll together) stops here.
    const claimed = await Order.findOneAndUpdate({ _id: order._id, invoice_id: null }, { $set: { invoice_id: invoiceId } }).lean();
    if (!claimed) return Invoice.findOne({ order_ids: order._id }).lean();
    const paid = order.payment_status === 'paid' ? order.amount_paid_rwf ?? order.total_rwf : 0;
    await Invoice.create({
      _id: invoiceId,
      vendor_id: order.vendor_id,
      invoice_number: await nextNumber(order.vendor_id),
      kind: 'order',
      is_open: false,
      order_ids: [order._id],
      lines: linesFrom(order),
      delivery_fee_rwf: order.delivery_fee_rwf || 0,
      amount_paid_rwf: paid,
      payments: paid ? [{ amount_rwf: paid, method: order.payment_method, channel: 'online', received_by: { type: 'system', name: 'KitchenLink' } }] : [],
      created_by: { type: 'system', name: 'System' },
    });
    return recalc(invoiceId);
  }

  /**
   * A dine-in order joins its table's open bill, or starts a new one: one
   * consolidated invoice for everything ordered at the table, whichever
   * departments prepare it.
   */
  async attachDineInOrder(order, table) {
    const lines = linesFrom(order);
    const push = { $push: { lines: { $each: lines } }, $addToSet: { order_ids: order._id } };
    const openFilter = { vendor_id: order.vendor_id, table_id: table._id, kind: 'table', is_open: true, status: { $in: OPEN } };
    let invoice = await Invoice.findOneAndUpdate(openFilter, push, { returnDocument: 'after' }).lean();
    if (!invoice) {
      try {
        invoice = (
          await Invoice.create({
            vendor_id: order.vendor_id,
            invoice_number: await nextNumber(order.vendor_id),
            kind: 'table',
            table_id: table._id,
            table_label: table.label,
            customer_name: order.guest?.name || '',
            order_ids: [order._id],
            lines,
            created_by: { type: 'system', name: 'Table QR order' },
          })
        ).toObject();
      } catch (error) {
        // Another order at the table opened the bill a moment ago: join it.
        if (error?.code !== 11000) throw error;
        invoice = await Invoice.findOneAndUpdate(openFilter, push, { returnDocument: 'after' }).lean();
      }
    }
    await Order.updateOne({ _id: order._id }, { $set: { invoice_id: invoice._id } });
    return recalc(invoice._id);
  }

  /** A cancelled order's lines no longer count on its bill. */
  async voidOrderLines(orderId) {
    const invoices = await Invoice.find({ order_ids: orderId }).select('_id kind').lean();
    for (const invoice of invoices) {
      await Invoice.updateOne(
        { _id: invoice._id },
        {
          $set: {
            'lines.$[l].voided': true,
            // An app order's own invoice: void (its refund goes through KitchenLink's refunds).
            ...(invoice.kind === 'order' ? { status: 'void', is_open: false } : {}),
          },
        },
        { arrayFilters: [{ 'l.order_id': new ObjectId(String(orderId)) }] }
      );
      await recalc(invoice._id);
    }
  }

  async list(kitchen, query = {}) {
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 25, maxLimit: 100 });
    const filter = { vendor_id: kitchen.vendorId };
    if (query.status === 'open') filter.status = { $in: OPEN };
    else if (['unpaid', 'partially_paid', 'paid', 'refunded', 'void'].includes(query.status)) filter.status = query.status;
    if (query.kind === 'table' || query.kind === 'order') filter.kind = query.kind;
    if (query.table_id && mongoose.isValidObjectId(query.table_id)) filter.table_id = query.table_id;
    if (typeof query.q === 'string' && query.q.trim()) {
      const q = query.q.trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 30);
      filter.$or = [{ invoice_number: { $regex: q, $options: 'i' } }, { 'lines.order_number': { $regex: q, $options: 'i' } }, { table_label: { $regex: q, $options: 'i' } }];
    }
    const range = {};
    if (query.from && !Number.isNaN(Date.parse(query.from))) range.$gte = new Date(query.from);
    if (query.to && !Number.isNaN(Date.parse(query.to))) range.$lte = new Date(query.to);
    if (Object.keys(range).length) filter.created_at = range;
    const [rows, total, open] = await Promise.all([
      Invoice.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: { vendor_id: new ObjectId(kitchen.vendorId), status: { $in: OPEN } } },
        { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $subtract: ['$total_rwf', '$amount_paid_rwf'] } } } },
      ]),
    ]);
    return {
      invoices: rows.map((row) => serialize(row)),
      summary: { open_count: open[0]?.n || 0, open_balance_rwf: open[0]?.due || 0 },
      meta: { page, limit, total },
    };
  }

  async #load(kitchen, invoiceId) {
    const id = parseObjectId(invoiceId, 'invoice_id');
    const invoice = await Invoice.findOne({ _id: id, vendor_id: kitchen.vendorId }).lean();
    if (!invoice) throw ApiError.notFound('Invoice not found.', 'INVOICE_NOT_FOUND');
    return invoice;
  }

  async get(kitchen, invoiceId) {
    const invoice = await this.#load(kitchen, invoiceId);
    const vendor = await Vendor.findById(kitchen.vendorId).select('name phone email address neighborhood').lean();
    const result = serialize(invoice, { vendor, detail: true });
    // Payment history only for people allowed to see it.
    if (!kitchen.can('invoices.payment_history') && !kitchen.can('invoices.process_payment')) {
      result.payments = result.payments.map(({ id, amount_rwf, method_label, at }) => ({ id, amount_rwf, method_label, at }));
      result.refunds = [];
    }
    return result;
  }

  /** The bill for an order, created now if it has none yet. */
  async generate(kitchen, body = {}) {
    const orderId = parseObjectId(body.order_id, 'order_id');
    const order = await Order.findOne({ _id: orderId, vendor_id: kitchen.vendorId }).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    let invoice;
    if (order.invoice_id) invoice = await Invoice.findById(order.invoice_id).lean();
    else if (order.fulfillment === 'dine_in') {
      const table = await mongoose.model('DiningTable').findById(order.table?.table_id).lean();
      if (!table) throw ApiError.conflict('This order has no table to bill.', 'INVOICE_NO_TABLE');
      invoice = await this.attachDineInOrder(order, table);
    } else {
      if (order.payment_status !== 'paid') throw ApiError.conflict('This order is not paid yet, so it has no invoice.', 'ORDER_NOT_PAID');
      invoice = await this.ensureForOrder(order._id);
    }
    await activity.record(kitchen, {
      action: 'invoice.generated',
      target_type: 'invoice',
      target_id: invoice._id,
      summary: `Opened invoice ${invoice.invoice_number} for ${order.order_number}`,
    });
    return this.get(kitchen, invoice._id);
  }

  async recordPayment(kitchen, invoiceId, body = {}) {
    const invoice = await this.#load(kitchen, invoiceId);
    if (invoice.kind !== 'table') {
      throw ApiError.conflict('This order was paid online; there is nothing to collect.', 'INVOICE_PAID_ONLINE');
    }
    if (!OPEN.includes(invoice.status)) throw ApiError.conflict('This invoice is already settled.', 'INVOICE_SETTLED');
    const amount = parseAmount(body.amount_rwf);
    const method = String(body.method || 'cash');
    if (!METHOD_IDS.includes(method)) throw ApiError.badRequest('Pick how the customer paid.', { method: `expected one of: ${METHOD_IDS.join(', ')}` });
    const reference = parseOptionalText(body.reference, { field: 'reference', max: 80 }) || '';
    const balance = invoice.total_rwf - invoice.amount_paid_rwf;
    if (amount > balance) {
      throw ApiError.badRequest(`That is more than the RWF ${balance.toLocaleString('en-US')} still due.`, { amount_rwf: `at most ${balance}` });
    }
    // Atomic: never takes the bill above its total, even with two cashiers.
    const updated = await Invoice.findOneAndUpdate(
      {
        _id: invoice._id,
        status: { $in: OPEN },
        $expr: { $lte: [{ $add: ['$amount_paid_rwf', amount] }, '$total_rwf'] },
      },
      {
        $inc: { amount_paid_rwf: amount },
        $push: { payments: { amount_rwf: amount, method, reference, channel: 'in_person', received_by: kitchen.actor, at: new Date() } },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) throw ApiError.conflict('The bill changed while you were entering the payment. Refresh and try again.', 'INVOICE_CHANGED');
    const saved = await recalc(invoice._id);
    await markOrdersPaid(saved);
    await activity.record(kitchen, {
      action: 'invoice.payment',
      target_type: 'invoice',
      target_id: invoice._id,
      summary: `Took RWF ${amount.toLocaleString('en-US')} (${methodLabel(method)}) on ${invoice.invoice_number}`,
      details: { amount_rwf: amount, method, reference },
    });
    return this.get(kitchen, invoice._id);
  }

  async refund(kitchen, invoiceId, body = {}) {
    const invoice = await this.#load(kitchen, invoiceId);
    const amount = parseAmount(body.amount_rwf);
    const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 }) || '';
    if (!reason) throw ApiError.badRequest('Say why the money is going back.', { reason: 'required' });
    const method = METHOD_IDS.includes(String(body.method)) ? String(body.method) : 'cash';
    const inPerson = (invoice.payments || []).filter((p) => p.channel === 'in_person').reduce((sum, p) => sum + p.amount_rwf, 0);
    const refundable = inPerson - (invoice.refunded_rwf || 0);
    if (refundable <= 0) {
      throw ApiError.conflict(
        invoice.kind === 'order'
          ? 'This order was paid online. Cancel the order to refund it through KitchenLink.'
          : 'Nothing paid in person is left to refund on this invoice.',
        'NOTHING_TO_REFUND'
      );
    }
    if (amount > refundable) throw ApiError.badRequest(`You can refund at most RWF ${refundable.toLocaleString('en-US')}.`, { amount_rwf: `at most ${refundable}` });
    const updated = await Invoice.findOneAndUpdate(
      { _id: invoice._id, refunded_rwf: invoice.refunded_rwf || 0 },
      { $inc: { refunded_rwf: amount }, $push: { refunds: { amount_rwf: amount, method, reason, by: kitchen.actor, at: new Date() } } },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) throw ApiError.conflict('Another refund was just recorded. Refresh and try again.', 'INVOICE_CHANGED');
    await recalc(invoice._id);
    await activity.record(kitchen, {
      action: 'invoice.refund',
      target_type: 'invoice',
      target_id: invoice._id,
      summary: `Refunded RWF ${amount.toLocaleString('en-US')} on ${invoice.invoice_number}`,
      details: { amount_rwf: amount, method, reason },
    });
    return this.get(kitchen, invoice._id);
  }

  /** Discount and notes (where the role allows editing invoices). */
  async edit(kitchen, invoiceId, body = {}) {
    const invoice = await this.#load(kitchen, invoiceId);
    if (!OPEN.includes(invoice.status)) throw ApiError.conflict('A settled invoice can no longer be changed.', 'INVOICE_SETTLED');
    const set = {};
    if (body.notes !== undefined) set.notes = parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '';
    if (body.customer_name !== undefined) set.customer_name = parseOptionalText(body.customer_name, { field: 'customer_name', max: 80 }) || '';
    if (body.discount_rwf !== undefined) {
      const discount = Number(body.discount_rwf);
      if (!Number.isInteger(discount) || discount < 0 || discount > invoice.subtotal_rwf + (invoice.delivery_fee_rwf || 0)) {
        throw ApiError.badRequest('The discount must be between 0 and the bill total.', { discount_rwf: 'out of range' });
      }
      if (invoice.kind === 'order') throw ApiError.conflict('Online orders are already paid; they cannot be discounted here.', 'INVOICE_PAID_ONLINE');
      set.discount_rwf = discount;
    }
    await Invoice.updateOne({ _id: invoice._id }, { $set: set });
    const saved = await recalc(invoice._id);
    await markOrdersPaid(saved);
    await activity.record(kitchen, {
      action: 'invoice.edited',
      target_type: 'invoice',
      target_id: invoice._id,
      summary: `Edited invoice ${invoice.invoice_number}`,
      details: set,
    });
    return this.get(kitchen, invoice._id);
  }

  /** Ends the table session: new orders at the table start a new bill. */
  async close(kitchen, invoiceId) {
    const invoice = await this.#load(kitchen, invoiceId);
    if (!invoice.is_open) return this.get(kitchen, invoice._id);
    await Invoice.updateOne({ _id: invoice._id }, { $set: { is_open: false, closed_at: new Date() } });
    await activity.record(kitchen, { action: 'invoice.closed', target_type: 'invoice', target_id: invoice._id, summary: `Closed the table bill ${invoice.invoice_number}` });
    return this.get(kitchen, invoice._id);
  }

  /** What a guest at the table sees of their bill. */
  async publicForOrder(order) {
    if (!order.invoice_id) return null;
    const invoice = await Invoice.findById(order.invoice_id).lean();
    if (!invoice) return null;
    const { lines, departments, total_rwf, amount_paid_rwf, balance_due_rwf, status, invoice_number, subtotal_rwf, discount_rwf } = serialize(invoice, { detail: true });
    return {
      invoice_number,
      status,
      subtotal_rwf,
      discount_rwf,
      total_rwf,
      amount_paid_rwf,
      balance_due_rwf,
      departments,
      lines: lines.filter((l) => !l.voided).map(({ name, quantity, subtotal_rwf: sub, department_name }) => ({ name, quantity, subtotal_rwf: sub, department_name })),
    };
  }
}

module.exports = new InvoiceService();
module.exports.serialize = serialize;
module.exports.recalc = recalc;

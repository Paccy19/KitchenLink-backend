const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { Invoice, Order, Vendor, Counter, Payment } = require('../../models');
const config = require('../../config');
const access = require('../../config/kitchenAccess');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const OPEN = ['unpaid', 'partially_paid'];
const METHOD_IDS = access.IN_PERSON_METHODS.map((m) => m.id);
const methodLabel = (id) =>
  (id === 'deposit' && 'Reservation deposit') ||
  access.IN_PERSON_METHODS.find((m) => m.id === id)?.label ||
  config.orders.paymentMethods.find((m) => m.code === id)?.label ||
  id;

const nextNumber = async (vendorId) => `INV-${String(await Counter.next(`invoice:${vendorId}`)).padStart(5, '0')}`;

const linesFrom = (order) =>
  (order.items || []).map((item) => ({
    order_id: order._id,
    order_number: order.order_number,
    item_id: item._id || null,
    menu_item_id: item.menu_item_id || null,
    table_session_id: order.table_session_id || null,
    customer_session_id: order.customer_session_id || null,
    seat_number: order.table?.seat_number ?? null,
    name: item.name,
    department_id: item.department_id || null,
    department_name: item.department_name || '',
    quantity: item.quantity,
    unit_price_rwf: item.quantity ? Math.round(item.subtotal_rwf / item.quantity) : item.price_rwf,
    subtotal_rwf: item.subtotal_rwf,
    // A cancelled order, or an item taken off it, no longer counts on the bill.
    voided: order.status === 'cancelled' || item.service_status === 'cancelled',
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
      {
        $set: {
          total_rwf: {
            $max: [
              0,
              {
                $subtract: [
                  { $add: ['$subtotal_rwf', '$delivery_fee_rwf'] },
                  { $add: ['$discount_rwf', { $ifNull: ['$promo_discount_rwf', 0] }, { $ifNull: ['$loyalty_discount_rwf', 0] }] },
                ],
              },
            ],
          },
        },
      },
      {
        $set: {
          status: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'void'] }, then: 'void' },
                { case: { $and: [{ $gt: ['$amount_paid_rwf', 0] }, { $gte: ['$refunded_rwf', '$amount_paid_rwf'] }] }, then: 'refunded' },
                {
                  case: { $and: [{ $gt: [{ $ifNull: ['$refunded_rwf', 0] }, 0] }, { $gte: ['$amount_paid_rwf', '$total_rwf'] }] },
                  then: 'partially_refunded',
                },
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
          is_open: { $cond: [{ $in: ['$status', ['paid', 'partially_refunded', 'refunded', 'void']] }, false, '$is_open'] },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true }
  ).lean();

/**
 * The bill is paid in full: its dine-in orders count as paid, once every
 * bill they are on is paid (a split bill puts one order on two bills).
 */
async function markOrdersPaid(invoice) {
  if (invoice.status !== 'paid') return;
  const orders = await Order.find({ _id: { $in: invoice.order_ids }, payment_method: 'in_person', payment_status: 'pending' })
    .select('_id total_rwf')
    .lean();
  for (const order of orders) {
    const unpaid = await Invoice.exists({ order_ids: order._id, status: { $in: OPEN } });
    if (unpaid) continue;
    await Order.updateOne({ _id: order._id, payment_status: 'pending' }, { $set: { payment_status: 'paid', amount_paid_rwf: order.total_rwf } });
  }
  require('./customerService').earnForInvoice(invoice._id).catch((error) => console.error('[loyalty]', error.message));
  if (invoice.session_id) {
    require('./alertService').emit(invoice.vendor_id, 'floor', {
      title: `${invoice.table_label || 'A table'} has paid`,
      body: `${invoice.invoice_number} is settled. The table can be closed once everything is served.`,
      link: '/vendor-dashboard/floor',
      permission: 'tables.close_sessions',
    });
  }
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
    promo_discount_rwf: invoice.promo_discount_rwf || 0,
    promotions: (invoice.promotions || []).map((p) => ({ name: p.name, code: p.code || null, amount_rwf: p.amount_rwf })),
    loyalty_points_redeemed: invoice.loyalty_points_redeemed || 0,
    loyalty_discount_rwf: invoice.loyalty_discount_rwf || 0,
    loyalty_points_earned: invoice.loyalty_points_earned || 0,
    kitchen_customer_id: invoice.kitchen_customer_id ? String(invoice.kitchen_customer_id) : null,
    split_from: invoice.split_from ? String(invoice.split_from) : null,
    merged_into: invoice.merged_into ? String(invoice.merged_into) : null,
    cancel_reason: invoice.cancel_reason || '',
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
      table_session_id: line.table_session_id ? String(line.table_session_id) : null,
      customer_session_id: line.customer_session_id ? String(line.customer_session_id) : null,
      seat_number: line.seat_number ?? null,
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

const parseIdempotencyKey = (raw) => {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(raw)) {
    throw ApiError.badRequest('A valid idempotency_key is required for each payment attempt.', {
      idempotency_key: 'expected 16-128 safe characters',
    });
  }
  return raw;
};

function discountAllocations(invoice, discount) {
  if (!discount) return [];
  const grossByOrder = new Map();
  const sessionByOrder = new Map();
  for (const line of invoice.lines || []) {
    if (line.voided || !line.order_id) continue;
    const key = String(line.order_id);
    grossByOrder.set(key, (grossByOrder.get(key) || 0) + line.subtotal_rwf);
    if (line.customer_session_id) sessionByOrder.set(key, line.customer_session_id);
  }
  const total = [...grossByOrder.values()].reduce((sum, amount) => sum + amount, 0);
  if (!total || discount > total) {
    throw ApiError.conflict('This discount cannot be safely allocated to the current table orders.', 'DISCOUNT_ALLOCATION_REQUIRED');
  }
  const rows = [...grossByOrder.entries()].map(([orderId, gross]) => {
    const raw = discount * gross / total;
    const amount = Math.floor(raw);
    return { order_id: new ObjectId(orderId), customer_session_id: sessionByOrder.get(orderId) || null, amount_rwf: amount, remainder: raw - amount };
  });
  let remaining = discount - rows.reduce((sum, row) => sum + row.amount_rwf, 0);
  rows.sort((a, b) => b.remainder - a.remainder || String(a.order_id).localeCompare(String(b.order_id)));
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) rows[index].amount_rwf += 1;
  return rows.map(({ order_id, customer_session_id, amount_rwf }) => ({ order_id, customer_session_id, amount_rwf }));
}

class InvoiceService {
  /** A bill just reached paid (by any path): its orders are paid and points earned. */
  markPaid(invoice) {
    return markOrdersPaid(invoice);
  }

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
  async attachDineInOrder(order, table, session = null) {
    const lines = linesFrom(order);
    const push = { $push: { lines: { $each: lines } }, $addToSet: { order_ids: order._id } };
    // One bill per table visit (session); without a session, the table's open bill.
    const openFilter = session
      ? { vendor_id: order.vendor_id, session_id: session._id, kind: 'table', is_open: true, status: { $in: OPEN } }
      : { vendor_id: order.vendor_id, table_id: table._id, kind: 'table', is_open: true, status: { $in: OPEN } };
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
            session_id: session?._id || null,
            kitchen_customer_id: session?.kitchen_customer_id || null,
            customer_name: order.guest?.name || session?.customer_name || '',
            order_ids: [order._id],
            lines,
            created_by: { type: 'system', name: 'Table order' },
          })
        ).toObject();
      } catch (error) {
        // Another order at the table opened the bill a moment ago: join it.
        if (error?.code !== 11000) throw error;
        invoice = await Invoice.findOneAndUpdate(openFilter, push, { returnDocument: 'after' }).lean();
      }
    }
    await Order.updateOne({ _id: order._id }, { $set: { invoice_id: invoice._id } });
    if (session && !session.invoice_id) await mongoose.model('TableSession').updateOne({ _id: session._id }, { $set: { invoice_id: invoice._id } });
    await require('./promotionService').refreshInvoice(invoice._id).catch((error) => console.error('[promotions]', error.message));
    return recalc(invoice._id);
  }

  /**
   * An order's items changed (added, removed, quantities, department): its
   * lines on the bill are replaced by the order's current items.
   */
  async syncOrderLines(orderId) {
    const order = await Order.findById(orderId).lean();
    if (!order?.invoice_id) return null;
    const oid = new ObjectId(String(order._id));
    await Invoice.updateOne({ _id: order.invoice_id }, { $pull: { lines: { order_id: oid } } });
    await Invoice.updateOne({ _id: order.invoice_id }, { $push: { lines: { $each: linesFrom(order) } } });
    await require('./promotionService').refreshInvoice(order.invoice_id).catch(() => null);
    return recalc(order.invoice_id);
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
    if (!['invoices.payment_history', 'invoices.process_payment', 'finance.transactions'].some((p) => kitchen.can(p))) {
      result.payments = result.payments.map(({ id, amount_rwf, method_label, at }) => ({ id, amount_rwf, method_label, at }));
      result.refunds = [];
    }
    return result;
  }

  /**
   * The invoice (or, once something is paid, the receipt) as a printable
   * page: `kind` 'invoice' | 'receipt'. Every value is escaped.
   */
  async document(kitchen, invoiceId, kind = 'invoice') {
    const receipt = kind === 'receipt';
    if (receipt) {
      if (!['invoices.receipts', 'invoices.print', 'invoices.download', 'invoices.process_payment', 'invoices.cash', 'invoices.digital'].some((p) => kitchen.can(p))) kitchen.assert('invoices.receipts');
    } else if (!['invoices.print', 'invoices.download', 'invoices.view', 'invoices.receipts', 'invoices.process_payment', 'invoices.cash', 'invoices.digital'].some((p) => kitchen.can(p))) kitchen.assert('invoices.print');
    const invoice = await this.#load(kitchen, invoiceId);
    if (receipt && !(invoice.amount_paid_rwf > 0)) throw ApiError.conflict('Nothing has been paid on this bill yet.', 'NOTHING_PAID');
    const vendor = await Vendor.findById(kitchen.vendorId).select('name phone email address neighborhood').lean();
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const rwf = (n) => `RWF ${Math.round(n || 0).toLocaleString('en-US')}`;
    const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kigali', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const lines = (invoice.lines || []).filter((l) => !l.voided);
    const discounts = (invoice.discount_rwf || 0) + (invoice.promo_discount_rwf || 0) + (invoice.loyalty_discount_rwf || 0);
    const due = Math.max(0, invoice.total_rwf - invoice.amount_paid_rwf);
    const rows = lines.map((l) => `<tr><td>${esc(l.quantity)}× ${esc(l.name)}</td><td class="r">${esc(rwf(l.subtotal_rwf))}</td></tr>`).join('');
    const payments = (invoice.payments || []).map((p) => `<tr><td>${esc(methodLabel(p.method))} · ${esc(when(p.at))}</td><td class="r">${esc(rwf(p.amount_rwf))}</td></tr>`).join('');
    const title = `${receipt ? 'Receipt' : 'Invoice'} ${invoice.invoice_number}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Georgia,serif;color:#2b1206;max-width:420px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}small,.m{color:#8a6a52;font-family:system-ui,sans-serif;font-size:12px}table{width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:13px;margin-top:14px}td{padding:6px 0;border-bottom:1px solid #eee}.r{text-align:right}.t td{font-weight:700;border-bottom:0;font-size:15px}@media print{body{margin:0}}</style></head><body>
<h1>${esc(vendor?.name || '')}</h1><p class="m">${esc([vendor?.address, vendor?.neighborhood].filter(Boolean).join(', '))}${vendor?.phone ? ` · ${esc(vendor.phone)}` : ''}</p>
<p><b>${esc(title)}</b><br><small>${esc(when(invoice.created_at))}${invoice.table_label ? ` · ${esc(invoice.table_label)}` : ''}${invoice.customer_name ? ` · ${esc(invoice.customer_name)}` : ''}</small></p>
<table>${rows}${discounts ? `<tr><td>Discounts</td><td class="r">− ${esc(rwf(discounts))}</td></tr>` : ''}<tr class="t"><td>Total</td><td class="r">${esc(rwf(invoice.total_rwf))}</td></tr></table>
${payments ? `<table><tr><td colspan="2"><b>Paid</b></td></tr>${payments}${invoice.refunded_rwf ? `<tr><td>Refunded</td><td class="r">− ${esc(rwf(invoice.refunded_rwf))}</td></tr>` : ''}</table>` : ''}
<table><tr class="t"><td>${due ? 'Still to pay' : 'Paid in full'}</td><td class="r">${due ? esc(rwf(due)) : ''}</td></tr></table>
<p class="m" style="text-align:center;margin-top:24px">Thank you · KitchenLink</p></body></html>`;
    activity.record(kitchen, { action: receipt ? 'invoice.receipt' : 'invoice.printed', target_type: 'invoice', target_id: invoice._id, summary: `${receipt ? 'Receipt' : 'Invoice'} ${invoice.invoice_number} printed or downloaded` });
    return { filename: `${receipt ? 'receipt' : 'invoice'}-${invoice.invoice_number}.html`, html };
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
    const amount = parseAmount(body.amount_rwf);
    const method = String(body.method || 'cash');
    if (!METHOD_IDS.includes(method)) throw ApiError.badRequest('Pick how the customer paid.', { method: `expected one of: ${METHOD_IDS.join(', ')}` });
    // Who may take this kind of payment, before anything else (a replay included).
    if (!kitchen.can('invoices.process_payment')) kitchen.assert(method === 'cash' ? 'invoices.cash' : 'invoices.digital');
    const reference = parseOptionalText(body.reference, { field: 'reference', max: 80 }) || '';
    const idempotencyKey = parseIdempotencyKey(body.idempotency_key);
    const requestHash = crypto.createHash('sha256')
      .update(JSON.stringify({ amount, method, reference }))
      .digest('hex');
    const previous = invoice.payments.find((payment) => payment.idempotency_key === idempotencyKey);
    if (previous) return this.#replayPayment(kitchen, invoice._id, previous, requestHash);

    const seatOwners = new Set(
      invoice.lines.map((line) => String(line.customer_session_id || '')).filter(Boolean)
    );
    if (seatOwners.size > 1) {
      throw ApiError.conflict(
        'This bill contains independently owned seat orders. Select the seats being paid so the payment can be allocated correctly.',
        'SEAT_SELECTION_REQUIRED'
      );
    }
    if (!OPEN.includes(invoice.status)) throw ApiError.conflict('This invoice is already settled.', 'INVOICE_SETTLED');
    const paymentPending = await Order.exists({ invoice_id: invoice._id, payment_lock_id: { $ne: null } });
    if (paymentPending) throw ApiError.conflict('A seat payment is being processed for this invoice. Try again when it completes.', 'SEAT_PAYMENT_PENDING');
    const balance = invoice.total_rwf - invoice.amount_paid_rwf;
    // "Process payments" covers every kind; otherwise cash and digital are separate,
    // and taking less than the balance is a part payment.
    if (!kitchen.can('invoices.process_payment')) {
      kitchen.assert(method === 'cash' ? 'invoices.cash' : 'invoices.digital');
      if (amount < balance) kitchen.assert('invoices.partial');
    }
    if (amount > balance) {
      throw ApiError.badRequest(`That is more than the RWF ${balance.toLocaleString('en-US')} still due.`, { amount_rwf: `at most ${balance}` });
    }
    // Atomic: never takes the bill above its total, even with two cashiers.
    const updated = await Invoice.findOneAndUpdate(
      {
        _id: invoice._id,
        status: { $in: OPEN },
        'payments.idempotency_key': { $ne: idempotencyKey },
        $expr: { $lte: [{ $add: ['$amount_paid_rwf', amount] }, '$total_rwf'] },
      },
      {
        $inc: { amount_paid_rwf: amount },
        $push: {
          payments: {
            amount_rwf: amount,
            method,
            reference,
            channel: 'in_person',
            received_by: kitchen.actor,
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            at: new Date(),
          },
        },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) {
      const current = await Invoice.findById(invoice._id).lean();
      const racedPayment = current?.payments.find((payment) => payment.idempotency_key === idempotencyKey);
      if (racedPayment) return this.#replayPayment(kitchen, invoice._id, racedPayment, requestHash);
      throw ApiError.conflict('The bill changed while you were entering the payment. Refresh and try again.', 'INVOICE_CHANGED');
    }
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

  /**
   * A reservation deposit counted as paid on the table's bill (never more
   * than the balance; what is left stays on the reservation). Internal: the
   * reservation service calls it when the guests are seated.
   */
  async applyDeposit(invoiceId, amount, { reference = '', actor }) {
    const invoice = await Invoice.findById(invoiceId).lean();
    if (!invoice || !OPEN.includes(invoice.status) || amount <= 0) return 0;
    const take = Math.min(amount, Math.max(0, invoice.total_rwf - invoice.amount_paid_rwf));
    // Before anything is ordered the bill is 0: the deposit is held and applied as orders arrive.
    if (take <= 0) return 0;
    const updated = await Invoice.findOneAndUpdate(
      { _id: invoice._id, status: { $in: OPEN }, $expr: { $lte: [{ $add: ['$amount_paid_rwf', take] }, '$total_rwf'] } },
      { $inc: { amount_paid_rwf: take }, $push: { payments: { amount_rwf: take, method: 'deposit', reference, channel: 'deposit', received_by: actor, at: new Date() } } },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) return 0;
    const saved = await recalc(invoice._id);
    await markOrdersPaid(saved);
    return take;
  }

  async #replayPayment(kitchen, invoiceId, payment, requestHash) {
    if (payment.request_hash !== requestHash) {
      throw ApiError.conflict('This idempotency key was already used for a different payment. Refresh the bill and start a new attempt.', 'IDEMPOTENCY_KEY_REUSED');
    }
    const reconciled = await recalc(invoiceId);
    await markOrdersPaid(reconciled);
    return this.get(kitchen, invoiceId);
  }

  async refund(kitchen, invoiceId, body = {}) {
    const invoice = await this.#load(kitchen, invoiceId);
    const seatPaymentIds = (invoice.payments || [])
      .map((payment) => payment.payment_id)
      .filter(Boolean);
    if (seatPaymentIds.length && await Payment.exists({
      _id: { $in: seatPaymentIds },
      table_session_id: { $ne: null },
      allocations: { $elemMatch: { invoice_id: invoice._id } },
    })) {
      throw ApiError.conflict(
        'This invoice includes seat-allocated payments. Refunds for those payments must be handled through a seat-level refund workflow.',
        'SEAT_PAYMENT_REFUND_UNSUPPORTED'
      );
    }
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
    if ((body.notes !== undefined || body.customer_name !== undefined) && !kitchen.can('invoices.edit')) kitchen.assert('invoices.edit');
    if (body.discount_rwf !== undefined) {
      if (!['invoices.discounts', 'promotions.manual_discounts', 'invoices.edit'].some((p) => kitchen.can(p))) kitchen.assert('invoices.discounts');
      const discount = Number(body.discount_rwf);
      if (!Number.isInteger(discount) || discount < 0 || discount > invoice.subtotal_rwf + (invoice.delivery_fee_rwf || 0)) {
        throw ApiError.badRequest('The discount must be between 0 and the bill total.', { discount_rwf: 'out of range' });
      }
      if (invoice.kind === 'order') throw ApiError.conflict('Online orders are already paid; they cannot be discounted here.', 'INVOICE_PAID_ONLINE');
      set.discount_rwf = discount;
      set.discount_allocations = discountAllocations(invoice, discount);
    }
    if (Object.keys(set).length && await Order.exists({ invoice_id: invoice._id, payment_lock_id: { $ne: null } })) {
      throw ApiError.conflict('A seat payment is being processed for this invoice. Try again when it completes.', 'SEAT_PAYMENT_PENDING');
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
    if (await Order.exists({ invoice_id: invoice._id, payment_lock_id: { $ne: null } })) {
      throw ApiError.conflict('A seat payment is being processed for this invoice. Try again when it completes.', 'SEAT_PAYMENT_PENDING');
    }
    await Invoice.updateOne({ _id: invoice._id }, { $set: { is_open: false, closed_at: new Date() } });
    await activity.record(kitchen, { action: 'invoice.closed', target_type: 'invoice', target_id: invoice._id, summary: `Closed the table bill ${invoice.invoice_number}` });
    return this.get(kitchen, invoice._id);
  }

  /**
   * "Split table bills": the chosen lines go to a new bill for the same
   * table (e.g. each guest pays their own). The original keeps the rest and
   * must still cover what was already paid on it.
   */
  async split(kitchen, invoiceId, body = {}) {
    if (!['invoices.split', 'tables.split_bills'].some((p) => kitchen.can(p))) kitchen.assert('invoices.split');
    const invoice = await this.#load(kitchen, invoiceId);
    if (invoice.kind !== 'table' || !OPEN.includes(invoice.status)) throw ApiError.conflict('Only an unpaid table bill can be split.', 'INVOICE_NOT_SPLITTABLE');
    const wanted = new Set(Array.isArray(body.line_ids) ? body.line_ids.map(String) : []);
    const live = invoice.lines.filter((l) => !l.voided);
    const moving = live.filter((l) => wanted.has(String(l._id)));
    if (!moving.length || moving.length === live.length) {
      throw ApiError.badRequest('Pick some (not all) of the items for the new bill.', { line_ids: 'expected part of the lines' });
    }
    const remaining = live.filter((l) => !wanted.has(String(l._id))).reduce((sum, l) => sum + l.subtotal_rwf, 0);
    if (invoice.amount_paid_rwf > remaining) {
      throw ApiError.conflict('More has already been paid than what would stay on this bill.', 'INVOICE_PAID_TOO_MUCH');
    }
    const ids = moving.map((l) => l._id);
    const updated = await Invoice.findOneAndUpdate(
      { _id: invoice._id, status: { $in: OPEN }, updated_at: invoice.updated_at },
      { $pull: { lines: { _id: { $in: ids } } } },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) throw ApiError.conflict('The bill changed meanwhile. Refresh and try again.', 'INVOICE_CHANGED');
    const orderIds = [...new Set(moving.map((l) => String(l.order_id)))];
    const created = await Invoice.create({
      vendor_id: invoice.vendor_id,
      invoice_number: await nextNumber(invoice.vendor_id),
      kind: 'table',
      table_id: invoice.table_id,
      table_label: invoice.table_label,
      customer_name: parseOptionalText(body.customer_name, { field: 'customer_name', max: 80 }) || '',
      is_open: false,
      split_from: invoice._id,
      order_ids: orderIds,
      lines: moving.map(({ _id, ...line }) => line),
      created_by: kitchen.actor,
    });
    // Orders now wholly on the new bill leave the old one.
    const stillHere = new Set(updated.lines.map((l) => String(l.order_id)));
    const gone = orderIds.filter((id) => !stillHere.has(id));
    if (gone.length) await Invoice.updateOne({ _id: invoice._id }, { $pull: { order_ids: { $in: gone.map((id) => new ObjectId(id)) } } });
    await Promise.all([recalc(invoice._id), recalc(created._id)]);
    await activity.record(kitchen, {
      action: 'invoice.split',
      target_type: 'invoice',
      target_id: invoice._id,
      summary: `Split ${moving.length} item${moving.length === 1 ? '' : 's'} of ${invoice.invoice_number} into ${created.invoice_number}`,
    });
    return { original: await this.get(kitchen, invoice._id), created: await this.get(kitchen, created._id) };
  }

  /**
   * "Cancel invoices": a table bill nothing was paid on. Its orders still in
   * progress are cancelled; served ones stay served (the bill is written off).
   */
  async cancel(kitchen, invoiceId, body = {}) {
    kitchen.assert('invoices.cancel');
    const invoice = await this.#load(kitchen, invoiceId);
    if (invoice.kind !== 'table') throw ApiError.conflict('App orders were paid online: cancel the order to refund it.', 'INVOICE_PAID_ONLINE');
    if (invoice.amount_paid_rwf > 0) throw ApiError.conflict('Something was already paid on this bill. Refund it first.', 'INVOICE_HAS_PAYMENTS');
    if (invoice.status === 'void') return this.get(kitchen, invoice._id);
    const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 }) || '';
    if (!reason) throw ApiError.badRequest('Say why the bill is cancelled.', { reason: 'required' });
    await Invoice.updateOne({ _id: invoice._id }, { $set: { status: 'void', is_open: false, cancel_reason: reason, closed_at: new Date() } });
    const vendor = await Vendor.findById(kitchen.vendorId).lean();
    const vendorOrderService = require('../vendorOrderService');
    const orders = await Order.find({ _id: { $in: invoice.order_ids }, status: { $nin: ['delivered', 'cancelled'] } }).lean();
    for (const order of orders) {
      try {
        await vendorOrderService.applyStatus(vendor, order, 'cancelled', { note: `Bill cancelled: ${reason}`, actor: kitchen.actor });
      } catch (error) {
        console.error('[invoice] could not cancel', order.order_number, error.message);
      }
    }
    await activity.record(kitchen, { action: 'invoice.cancelled', target_type: 'invoice', target_id: invoice._id, summary: `Cancelled ${invoice.invoice_number}: ${reason}` });
    return this.get(kitchen, invoice._id);
  }

  /**
   * "Merge tables": everything open at another table (its orders and its
   * bill, payments included) joins this table.
   */
  async mergeTables(kitchen, targetTable, fromTable) {
    const DiningTable = mongoose.model('DiningTable');
    const target = await DiningTable.findOne({ _id: targetTable, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    const from = await DiningTable.findOne({ _id: fromTable, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!target || !from) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    if (String(target._id) === String(from._id)) throw ApiError.badRequest('Pick another table to merge.', { from_table_id: 'same table' });
    const now = new Date();
    // The two visits become one: the merged table's visit ends inside the other.
    const TableSession = mongoose.model('TableSession');
    const fromSession = await TableSession.findOne({ vendor_id: kitchen.vendorId, table_id: from._id, status: 'active' }).lean();
    let targetSession = await TableSession.findOne({ vendor_id: kitchen.vendorId, table_id: target._id, status: 'active' }).lean();
    if (fromSession && !targetSession) {
      await TableSession.updateOne({ _id: fromSession._id }, { $set: { table_id: target._id, table_label: target.label }, $push: { transfers: { from_label: from.label, to_label: target.label, at: now, by: kitchen.actor.name } } });
      targetSession = { ...fromSession, table_id: target._id };
    } else if (fromSession && targetSession) {
      await TableSession.updateOne(
        { _id: targetSession._id },
        {
          $addToSet: { order_ids: { $each: fromSession.order_ids || [] } },
          ...(fromSession.guest_count || targetSession.guest_count ? { $set: { guest_count: (targetSession.guest_count || 0) + (fromSession.guest_count || 0) } } : {}),
        }
      );
      await TableSession.updateOne({ _id: fromSession._id }, { $set: { status: 'closed', closed_at: now, closed_by: kitchen.actor, close_exceptions: [`Merged into ${target.label}`] } });
      await Invoice.updateMany({ session_id: fromSession._id }, { $set: { session_id: targetSession._id } });
    }
    await Order.updateMany(
      { vendor_id: kitchen.vendorId, 'table.table_id': from._id, status: { $nin: ['delivered', 'cancelled'] } },
      {
        $set: { table: { table_id: target._id, label: target.label }, ...(targetSession ? { table_session_id: targetSession._id } : {}) },
        $push: { status_history: { status: 'placed', at: now, note: `Merged from ${from.label} into ${target.label}` } },
      }
    );
    const fromBill = await Invoice.findOne({ vendor_id: kitchen.vendorId, table_id: from._id, kind: 'table', is_open: true }).lean();
    if (fromBill) {
      const targetBill = await Invoice.findOne({ vendor_id: kitchen.vendorId, table_id: target._id, kind: 'table', is_open: true }).lean();
      if (!targetBill) {
        await Invoice.updateOne({ _id: fromBill._id }, { $set: { table_id: target._id, table_label: target.label } });
      } else {
        await Invoice.updateOne(
          { _id: targetBill._id },
          {
            $push: { lines: { $each: fromBill.lines.map(({ _id, ...l }) => l) }, payments: { $each: fromBill.payments.map(({ _id, ...p }) => p) } },
            $addToSet: { order_ids: { $each: fromBill.order_ids } },
            $inc: { amount_paid_rwf: fromBill.amount_paid_rwf || 0, refunded_rwf: fromBill.refunded_rwf || 0 },
          }
        );
        await Invoice.updateOne({ _id: fromBill._id }, { $set: { status: 'void', is_open: false, merged_into: targetBill._id, closed_at: now, cancel_reason: `Merged into ${targetBill.invoice_number}` } });
        await Order.updateMany({ _id: { $in: fromBill.order_ids } }, { $set: { invoice_id: targetBill._id } });
        await recalc(targetBill._id);
      }
    }
    await activity.record(kitchen, { action: 'table.merged', target_type: 'table', target_id: target._id, summary: `Merged ${from.label} into ${target.label}` });
    return { merged: true, table_id: String(target._id) };
  }

  /** What a guest at the table sees of their bill. */
  async publicForOrder(order) {
    if (!order.invoice_id) return null;
    const invoice = await Invoice.findById(order.invoice_id).lean();
    if (!invoice) return null;
    const details = serialize(invoice, { detail: true });
    const sessionOrders = order.table_session_id && order.customer_session_id
      ? await Order.find({
          table_session_id: order.table_session_id,
          customer_session_id: order.customer_session_id,
          invoice_id: invoice._id,
          status: { $ne: 'cancelled' },
        }).select('_id total_rwf amount_paid_rwf payment_status').lean()
      : [order];
    const orderIds = new Set(sessionOrders.map((entry) => String(entry._id)));
    const lines = details.lines.filter((line) => !line.voided && orderIds.has(line.order_id));
    const subtotal = lines.reduce((sum, line) => sum + line.subtotal_rwf, 0);
    const orderIdList = sessionOrders.map((entry) => String(entry._id));
    const allocatedDiscount = (invoice.discount_allocations || [])
      .filter((entry) => orderIdList.includes(String(entry.order_id)))
      .reduce((sum, entry) => sum + (entry.amount_rwf || 0), 0);
    const totalDiscountAllocated = (invoice.discount_allocations || [])
      .reduce((sum, entry) => sum + (entry.amount_rwf || 0), 0);
    const discountNeedsReconciliation = (invoice.discount_rwf || 0) > 0 &&
      totalDiscountAllocated !== invoice.discount_rwf;
    const total = Math.max(
      0,
      sessionOrders.reduce((sum, entry) => sum + (entry.total_rwf || 0), 0) - allocatedDiscount
    );
    const paid = sessionOrders.reduce((sum, entry) =>
      sum + (entry.amount_paid_rwf ?? (entry.payment_status === 'paid' ? entry.total_rwf : 0)), 0);
    const departmentsByName = new Map();
    for (const line of lines) {
      const key = line.department_id || 'main';
      const row = departmentsByName.get(key) || {
        department_id: line.department_id,
        department_name: line.department_name,
        subtotal_rwf: 0,
        items: 0,
      };
      row.subtotal_rwf += line.subtotal_rwf;
      row.items += line.quantity;
      departmentsByName.set(key, row);
    }
    const balance = Math.max(0, total - paid);
    return {
      invoice_number: details.invoice_number,
      status: discountNeedsReconciliation
        ? 'staff_reconciliation_required'
        : balance === 0 && total > 0
          ? 'paid'
          : paid > 0
            ? 'partially_paid'
            : 'unpaid',
      subtotal_rwf: subtotal,
      discount_rwf: allocatedDiscount,
      total_rwf: total,
      amount_paid_rwf: paid,
      balance_due_rwf: balance,
      departments: [...departmentsByName.values()],
      lines: lines.map(({ name, quantity, subtotal_rwf: sub, department_name }) => ({ name, quantity, subtotal_rwf: sub, department_name })),
    };
  }
}

module.exports = new InvoiceService();
module.exports.serialize = serialize;
module.exports.recalc = recalc;

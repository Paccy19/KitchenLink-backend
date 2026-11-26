const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { CashierSession, Expense, Invoice, Order, Refund } = require('../../models');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const EXPENSE_CATEGORIES = ['Stock purchases', 'Salaries', 'Rent', 'Utilities', 'Gas & fuel', 'Equipment', 'Repairs', 'Transport', 'Marketing', 'Taxes & fees', 'Other'];

const money = (raw, field) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1000000000) throw ApiError.badRequest(`${field} must be a whole number of RWF.`, { [field]: 'expected an integer >= 0' });
  return n;
};
const parseDate = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${field} is not a valid date.`, { [field]: 'expected a date' });
  return d;
};
const range = (query) => {
  const to = query.to ? parseDate(query.to, 'to') : new Date();
  const from = query.from ? parseDate(query.from, 'from') : new Date(to.getTime() - 30 * 86400000);
  if (to <= from) throw ApiError.badRequest('The end must be after the start.', { to: 'before from' });
  return { from, to };
};

// ----------------------------------------------------------- cashier sessions

const serializeSession = (s) => ({
  id: String(s._id),
  cashier: s.cashier?.name || '',
  cashier_id: s.cashier?.id || null,
  status: s.status,
  opened_at: s.opened_at,
  opening_float_rwf: s.opening_float_rwf,
  closed_at: s.closed_at,
  closed_by: s.closed_by?.name || null,
  counted_cash_rwf: s.counted_cash_rwf,
  expected_cash_rwf: s.expected_cash_rwf,
  difference_rwf: s.difference_rwf,
  totals_by_method: s.totals_by_method || {},
  payments_count: s.payments_count || 0,
  refunds_rwf: s.refunds_rwf || 0,
  notes: s.notes || '',
});

/** What a cashier took between two moments (payments they recorded, cash refunds they gave). */
async function takings(vendorId, cashierId, from, to) {
  const invoices = await Invoice.find({
    vendor_id: vendorId,
    $or: [{ 'payments.at': { $gte: from, $lte: to } }, { 'refunds.at': { $gte: from, $lte: to } }],
  })
    .select('payments refunds')
    .lean();
  const totals = {};
  let count = 0;
  let cashRefunds = 0;
  let refunds = 0;
  for (const invoice of invoices) {
    for (const p of invoice.payments || []) {
      if (p.channel !== 'in_person' || p.at < from || p.at > to) continue;
      if (cashierId && p.received_by?.id !== cashierId) continue;
      totals[p.method] = (totals[p.method] || 0) + p.amount_rwf;
      count += 1;
    }
    for (const r of invoice.refunds || []) {
      if (r.at < from || r.at > to) continue;
      if (cashierId && r.by?.id !== cashierId) continue;
      refunds += r.amount_rwf;
      if (r.method === 'cash') cashRefunds += r.amount_rwf;
    }
  }
  return { totals, count, cashRefunds, refunds };
}

class FinanceService {
  // ------------------------------------------------ cashier sessions

  async sessions(kitchen, query = {}) {
    if (!['invoices.cashier_sessions', 'invoices.cashier_reports'].some((p) => kitchen.can(p))) kitchen.assert('invoices.cashier_sessions');
    const filter = { vendor_id: kitchen.vendorId };
    if (query.status === 'open' || query.status === 'closed') filter.status = query.status;
    const rows = await CashierSession.find(filter).sort({ opened_at: -1 }).limit(60).lean();
    const mine = await CashierSession.findOne({ vendor_id: kitchen.vendorId, 'cashier.id': kitchen.actor.id, status: 'open' }).lean();
    return { sessions: rows.map(serializeSession), mine: mine ? serializeSession(mine) : null };
  }

  /** Opens the till for the person signed in (their payments count towards it). */
  async openSession(kitchen, body = {}) {
    if (!['invoices.cashier_sessions', 'invoices.process_payment', 'invoices.cash'].some((p) => kitchen.can(p))) kitchen.assert('invoices.cashier_sessions');
    try {
      const session = await CashierSession.create({
        vendor_id: kitchen.vendorId,
        cashier: kitchen.actor,
        opening_float_rwf: money(body.opening_float_rwf ?? 0, 'opening_float_rwf'),
        notes: parseOptionalText(body.notes, { field: 'notes', max: 200 }) || '',
      });
      await activity.record(kitchen, { action: 'cashier.opened', target_type: 'cashier_session', target_id: session._id, summary: `${kitchen.actor.name} opened the till (float RWF ${session.opening_float_rwf.toLocaleString('en-US')})` });
      return serializeSession(session.toObject());
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('You already have an open till. Close it first.', 'SESSION_ALREADY_OPEN');
      throw error;
    }
  }

  /** "Close cashier sessions": counted cash against float + cash taken − cash refunded. */
  async closeSession(kitchen, sessionId, body = {}) {
    const session = await CashierSession.findOne({ _id: parseObjectId(sessionId, 'session_id'), vendor_id: kitchen.vendorId }).lean();
    if (!session) throw ApiError.notFound('Till session not found.', 'SESSION_NOT_FOUND');
    if (session.cashier?.id !== kitchen.actor.id) kitchen.assert('invoices.cashier_sessions');
    if (session.status === 'closed') return serializeSession(session);
    const counted = money(body.counted_cash_rwf, 'counted_cash_rwf');
    const now = new Date();
    const { totals, count, cashRefunds, refunds } = await takings(kitchen.vendorId, session.cashier.id, session.opened_at, now);
    const expected = session.opening_float_rwf + (totals.cash || 0) - cashRefunds;
    const saved = await CashierSession.findOneAndUpdate(
      { _id: session._id, status: 'open' },
      {
        $set: {
          status: 'closed',
          closed_at: now,
          closed_by: kitchen.actor,
          counted_cash_rwf: counted,
          expected_cash_rwf: expected,
          difference_rwf: counted - expected,
          totals_by_method: totals,
          payments_count: count,
          refunds_rwf: refunds,
          notes: [session.notes, parseOptionalText(body.notes, { field: 'notes', max: 300 }) || ''].filter(Boolean).join(' · '),
        },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This till was just closed.', 'SESSION_CLOSED');
    await activity.record(kitchen, {
      action: 'cashier.closed',
      target_type: 'cashier_session',
      target_id: session._id,
      summary: `Till of ${session.cashier.name} closed: counted RWF ${counted.toLocaleString('en-US')}, expected RWF ${expected.toLocaleString('en-US')}`,
      details: { difference_rwf: counted - expected },
    });
    return serializeSession(saved);
  }

  /** "View cashier reports": what each cashier took, by method, over a period. */
  async cashierReport(kitchen, query = {}) {
    if (!['invoices.cashier_reports', 'reports.payments', 'reports.financial'].some((p) => kitchen.can(p))) kitchen.assert('invoices.cashier_reports');
    const { from, to } = range(query);
    const invoices = await Invoice.find({ vendor_id: kitchen.vendorId, 'payments.at': { $gte: from, $lte: to } }).select('payments refunds').lean();
    const byCashier = new Map();
    for (const invoice of invoices) {
      for (const p of invoice.payments || []) {
        if (p.at < from || p.at > to) continue;
        const key = p.channel === 'online' ? 'online' : p.received_by?.id || 'unknown';
        const row = byCashier.get(key) || { cashier: p.channel === 'online' ? 'Paid in the app' : p.received_by?.name || 'Unknown', payments: 0, total_rwf: 0, by_method: {} };
        row.payments += 1;
        row.total_rwf += p.amount_rwf;
        row.by_method[p.method] = (row.by_method[p.method] || 0) + p.amount_rwf;
        byCashier.set(key, row);
      }
    }
    const sessions = await CashierSession.find({ vendor_id: kitchen.vendorId, opened_at: { $gte: from, $lte: to } }).sort({ opened_at: -1 }).lean();
    return { from, to, cashiers: [...byCashier.values()].sort((a, b) => b.total_rwf - a.total_rwf), sessions: sessions.map(serializeSession) };
  }

  // ------------------------------------------------ expenses

  #serializeExpense(e) {
    return {
      id: String(e._id),
      date: e.date,
      category: e.category,
      description: e.description || '',
      amount_rwf: e.amount_rwf,
      department_id: e.department_id ? String(e.department_id) : null,
      supplier_id: e.supplier_id ? String(e.supplier_id) : null,
      payment_method: e.payment_method,
      reference: e.reference || '',
      from_purchase_order: Boolean(e.purchase_order_id),
      recorded_by: e.recorded_by?.name || '',
      created_at: e.created_at,
    };
  }

  async listExpenses(kitchen, query = {}) {
    kitchen.assert('finance.expenses_view');
    const { from, to } = range(query);
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 200 });
    const filter = { vendor_id: new ObjectId(kitchen.vendorId), deleted_at: null, date: { $gte: from, $lte: to } };
    if (typeof query.category === 'string' && query.category) filter.category = query.category;
    const [rows, total, sums] = await Promise.all([
      Expense.find(filter).sort({ date: -1 }).skip(offset).limit(limit).lean(),
      Expense.countDocuments(filter),
      Expense.aggregate([{ $match: filter }, { $group: { _id: '$category', total: { $sum: '$amount_rwf' } } }]),
    ]);
    return {
      expenses: rows.map((e) => this.#serializeExpense(e)),
      by_category: sums.map((s) => ({ category: s._id, total_rwf: s.total })).sort((a, b) => b.total_rwf - a.total_rwf),
      total_rwf: sums.reduce((sum, s) => sum + s.total, 0),
      categories: EXPENSE_CATEGORIES,
      meta: { page, limit, total },
    };
  }

  async #parseExpense(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.date !== undefined) update.date = parseDate(body.date, 'date');
    if (!partial || body.category !== undefined) update.category = parseRequiredText(body.category, { field: 'category', min: 2, max: 40 });
    if (body.description !== undefined) update.description = parseOptionalText(body.description, { field: 'description', max: 200 }) || '';
    if (!partial || body.amount_rwf !== undefined) {
      update.amount_rwf = money(body.amount_rwf, 'amount_rwf');
      if (update.amount_rwf < 1) throw ApiError.badRequest('The amount must be above 0.', { amount_rwf: 'expected > 0' });
    }
    if (body.department_id !== undefined) update.department_id = await departmentService.resolveId(kitchen.vendorId, body.department_id);
    if (body.supplier_id !== undefined) update.supplier_id = body.supplier_id ? parseObjectId(body.supplier_id, 'supplier_id') : null;
    if (body.payment_method !== undefined) update.payment_method = ['cash', 'mobile_money', 'card', 'bank', 'other'].includes(body.payment_method) ? body.payment_method : 'other';
    if (body.reference !== undefined) update.reference = parseOptionalText(body.reference, { field: 'reference', max: 80 }) || '';
    return update;
  }

  async createExpense(kitchen, body = {}) {
    kitchen.assert('finance.expenses_record');
    const update = await this.#parseExpense(kitchen, body, { partial: false });
    const expense = await Expense.create({ ...update, vendor_id: kitchen.vendorId, recorded_by: kitchen.actor });
    await activity.record(kitchen, { action: 'expense.recorded', target_type: 'expense', target_id: expense._id, summary: `Expense RWF ${expense.amount_rwf.toLocaleString('en-US')} (${expense.category})` });
    return this.#serializeExpense(expense.toObject());
  }

  /** Purchase orders received with a cost record their expense themselves. */
  async recordPurchase(vendorId, { amount_rwf: amount, supplier_id: supplierId, purchase_order_id: purchaseOrderId, description, actor }) {
    if (!amount) return null;
    return Expense.create({
      vendor_id: vendorId,
      date: new Date(),
      category: 'Stock purchases',
      description,
      amount_rwf: amount,
      supplier_id: supplierId || null,
      purchase_order_id: purchaseOrderId,
      recorded_by: actor,
    });
  }

  async updateExpense(kitchen, expenseId, body = {}) {
    kitchen.assert('finance.expenses_edit');
    const update = await this.#parseExpense(kitchen, body, { partial: true });
    const saved = await Expense.findOneAndUpdate({ _id: parseObjectId(expenseId, 'expense_id'), vendor_id: kitchen.vendorId, deleted_at: null }, { $set: update }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.notFound('Expense not found.', 'EXPENSE_NOT_FOUND');
    await activity.record(kitchen, { action: 'expense.edited', target_type: 'expense', target_id: saved._id, summary: `Edited an expense (${saved.category})` });
    return this.#serializeExpense(saved);
  }

  async deleteExpense(kitchen, expenseId) {
    kitchen.assert('finance.expenses_delete');
    const saved = await Expense.findOneAndUpdate({ _id: parseObjectId(expenseId, 'expense_id'), vendor_id: kitchen.vendorId, deleted_at: null }, { $set: { deleted_at: new Date() } }).lean();
    if (!saved) throw ApiError.notFound('Expense not found.', 'EXPENSE_NOT_FOUND');
    await activity.record(kitchen, { action: 'expense.deleted', target_type: 'expense', target_id: saved._id, summary: `Deleted an expense of RWF ${saved.amount_rwf.toLocaleString('en-US')} (${saved.category})` });
    return { deleted: true, id: String(saved._id) };
  }

  // ------------------------------------------------ profit and loss

  /**
   * "View profit and loss reports": sales, what KitchenLink kept, refunds
   * and expenses over a period (the report's own period rules apply).
   */
  async profitAndLoss(kitchen, query = {}) {
    kitchen.assert('finance.profit_loss');
    const reportService = require('./reportService');
    const period = reportService.parsePeriod(query);
    const vid = new ObjectId(kitchen.vendorId);
    const orders = await Order.find({ vendor_id: vid, created_at: { $gte: period.start, $lt: period.end }, status: { $ne: 'cancelled' } })
      .select('payment_method payment_status subtotal_rwf delivery_fee_rwf commission_rwf fulfillment')
      .lean();
    const sale = (o) => o.payment_status === 'paid' || o.payment_method === 'in_person';
    const sold = orders.filter(sale);
    const food = sold.reduce((s, o) => s + o.subtotal_rwf, 0);
    // Delivery fees go to the delivery worker, except on orders the kitchen delivers itself.
    const ownDelivery = sold.filter((o) => o.fulfillment === 'vendor_delivery').reduce((s, o) => s + (o.delivery_fee_rwf || 0), 0);
    const commission = sold.reduce((s, o) => s + (o.commission_rwf || 0), 0);
    const [expenses, invoices, refunds] = await Promise.all([
      Expense.aggregate([
        { $match: { vendor_id: vid, deleted_at: null, date: { $gte: period.start, $lt: period.end } } },
        { $group: { _id: '$category', total: { $sum: '$amount_rwf' } } },
      ]),
      Invoice.find({ vendor_id: vid, 'refunds.at': { $gte: period.start, $lt: period.end } }).select('refunds discount_rwf').lean(),
      Refund.find({ vendor_id: vid, created_at: { $gte: period.start, $lt: period.end } }).select('amount_rwf').lean().catch(() => []),
    ]);
    const inPersonRefunds = invoices.flatMap((i) => i.refunds || []).filter((r) => r.at >= period.start && r.at < period.end).reduce((s, r) => s + r.amount_rwf, 0);
    const onlineRefunds = refunds.reduce((s, r) => s + (r.amount_rwf || 0), 0);
    const expenseTotal = expenses.reduce((s, e) => s + e.total, 0);
    const revenue = food + ownDelivery;
    const net = revenue - commission - inPersonRefunds - onlineRefunds - expenseTotal;
    return {
      period: { type: period.type, label: period.label, start: period.start, end: period.end },
      revenue: { food_rwf: food, own_delivery_fees_rwf: ownDelivery, total_rwf: revenue },
      costs: {
        commission_rwf: commission,
        refunds_rwf: inPersonRefunds + onlineRefunds,
        expenses_rwf: expenseTotal,
        expenses_by_category: expenses.map((e) => ({ category: e._id, total_rwf: e.total })).sort((a, b) => b.total_rwf - a.total_rwf),
      },
      profit_rwf: net,
      margin_percent: revenue ? Math.round((net / revenue) * 1000) / 10 : null,
      note: 'Sales count orders placed in the period that were not cancelled. Stock bought appears through expenses (recorded by hand or when a purchase order is received).',
    };
  }

  /** "View financial transactions": every money movement in one list, newest first. */
  async transactions(kitchen, query = {}) {
    kitchen.assert('finance.transactions');
    const { from, to } = range(query);
    const [invoices, expenses] = await Promise.all([
      Invoice.find({ vendor_id: kitchen.vendorId, $or: [{ 'payments.at': { $gte: from, $lte: to } }, { 'refunds.at': { $gte: from, $lte: to } }] }).select('invoice_number table_label payments refunds').lean(),
      kitchen.can('finance.expenses_view') ? Expense.find({ vendor_id: kitchen.vendorId, deleted_at: null, date: { $gte: from, $lte: to } }).lean() : [],
    ]);
    const rows = [];
    for (const i of invoices) {
      for (const p of i.payments || []) {
        if (p.at >= from && p.at <= to) rows.push({ at: p.at, kind: 'payment', amount_rwf: p.amount_rwf, method: p.method, channel: p.channel, reference: i.invoice_number, label: i.table_label || 'App order', by: p.received_by?.name || '' });
      }
      for (const r of i.refunds || []) {
        if (r.at >= from && r.at <= to) rows.push({ at: r.at, kind: 'refund', amount_rwf: -r.amount_rwf, method: r.method, channel: 'in_person', reference: i.invoice_number, label: r.reason, by: r.by?.name || '' });
      }
    }
    for (const e of expenses) rows.push({ at: e.date, kind: 'expense', amount_rwf: -e.amount_rwf, method: e.payment_method, channel: 'in_person', reference: e.reference || '', label: `${e.category}${e.description ? `: ${e.description}` : ''}`, by: e.recorded_by?.name || '' });
    rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    return {
      from,
      to,
      transactions: rows.slice(0, 500),
      totals: {
        in_rwf: rows.filter((r) => r.amount_rwf > 0).reduce((s, r) => s + r.amount_rwf, 0),
        out_rwf: -rows.filter((r) => r.amount_rwf < 0).reduce((s, r) => s + r.amount_rwf, 0),
      },
    };
  }
}

module.exports = new FinanceService();
module.exports.takings = takings;
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;

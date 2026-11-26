const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { normalizePhone } = require('../../utils/validators');
const { KitchenCustomer, Customer, Order, Invoice, Feedback, Vendor } = require('../../models');
const notificationService = require('../notificationService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;

const serialize = (c, stats = {}) => ({
  id: String(c._id),
  name: c.name,
  phone: c.phone || null,
  email: c.email || '',
  notes: c.notes || '',
  tags: c.tags || [],
  app_customer: Boolean(c.customer_id),
  loyalty_points: c.loyalty_points || 0,
  discount_percent: c.discount_percent || 0,
  orders_count: stats.orders || 0,
  total_spent_rwf: stats.spent || 0,
  last_order_at: stats.last || null,
  created_at: c.created_at,
});

/**
 * The kitchen's customers. App customers appear by themselves once they
 * order (their record is created on first sight); regulars can be added by
 * the cashier to collect loyalty points on table bills.
 */
class CustomerService {
  /** The kitchen's record of an app customer, created the first time it's needed. */
  async forAppCustomer(vendorId, customerId) {
    if (!customerId) return null;
    const existing = await KitchenCustomer.findOne({ vendor_id: vendorId, customer_id: customerId }).lean();
    if (existing) return existing;
    const customer = await Customer.findById(customerId).lean();
    if (!customer) return null;
    try {
      return (await KitchenCustomer.create({ vendor_id: vendorId, customer_id: customerId, name: customer.name || 'Customer', phone: customer.phone_number || null })).toObject();
    } catch (error) {
      if (error?.code === 11000) return KitchenCustomer.findOne({ vendor_id: vendorId, customer_id: customerId }).lean();
      throw error;
    }
  }

  /** Brings app customers who ordered into the list (cheap: only those not seen yet). */
  async #syncAppCustomers(vendorId) {
    const ids = await Order.distinct('customer_id', { vendor_id: vendorId, customer_id: { $ne: null } });
    const known = new Set((await KitchenCustomer.find({ vendor_id: vendorId, customer_id: { $in: ids } }).select('customer_id').lean()).map((c) => String(c.customer_id)));
    for (const id of ids.filter((id) => !known.has(String(id))).slice(0, 200)) await this.forAppCustomer(vendorId, id);
  }

  async #stats(vendorId, customers) {
    const appIds = customers.filter((c) => c.customer_id).map((c) => c.customer_id);
    const localIds = customers.map((c) => c._id);
    const rows = await Order.aggregate([
      { $match: { vendor_id: new ObjectId(String(vendorId)), status: { $ne: 'cancelled' }, $or: [{ customer_id: { $in: appIds } }, { kitchen_customer_id: { $in: localIds } }] } },
      { $group: { _id: { app: '$customer_id', local: '$kitchen_customer_id' }, orders: { $sum: 1 }, spent: { $sum: '$total_rwf' }, last: { $max: '$created_at' } } },
    ]);
    const map = new Map();
    for (const c of customers) {
      const mine = rows.filter((r) => (c.customer_id && String(r._id.app) === String(c.customer_id)) || String(r._id.local) === String(c._id));
      map.set(String(c._id), {
        orders: mine.reduce((s, r) => s + r.orders, 0),
        spent: mine.reduce((s, r) => s + r.spent, 0),
        last: mine.reduce((m, r) => (!m || r.last > m ? r.last : m), null),
      });
    }
    return map;
  }

  async list(kitchen, query = {}) {
    if (!require('../../config/kitchenAccess').inGroup('customers').some((p) => kitchen.can(p))) kitchen.assert('customers.view');
    await this.#syncAppCustomers(kitchen.vendorId);
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 30, maxLimit: 100 });
    const filter = { vendor_id: kitchen.vendorId, deleted_at: null };
    if (typeof query.q === 'string' && query.q.trim()) {
      const rx = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { phone: { $regex: rx } }, { tags: { $regex: rx, $options: 'i' } }];
    }
    const [rows, total] = await Promise.all([KitchenCustomer.find(filter).sort({ updated_at: -1 }).skip(offset).limit(limit).lean(), KitchenCustomer.countDocuments(filter)]);
    const stats = await this.#stats(kitchen.vendorId, rows);
    const canPhone = kitchen.can('customers.profiles') || kitchen.can('customers.manage');
    return {
      customers: rows.map((c) => {
        const out = serialize(c, stats.get(String(c._id)));
        if (!canPhone) out.phone = out.phone ? `${out.phone.slice(0, 4)}•••${out.phone.slice(-2)}` : null;
        return out;
      }),
      meta: { page, limit, total },
    };
  }

  async #load(kitchen, customerId) {
    const c = await KitchenCustomer.findOne({ _id: parseObjectId(customerId, 'customer_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!c) throw ApiError.notFound('Customer not found.', 'CUSTOMER_NOT_FOUND');
    return c;
  }

  async get(kitchen, customerId) {
    kitchen.assert('customers.profiles');
    const c = await this.#load(kitchen, customerId);
    const stats = (await this.#stats(kitchen.vendorId, [c])).get(String(c._id));
    const result = serialize(c, stats);
    if (kitchen.can('customers.order_history')) {
      const or = [{ kitchen_customer_id: c._id }];
      if (c.customer_id) or.push({ customer_id: c.customer_id });
      const orders = await Order.find({ vendor_id: kitchen.vendorId, $or: or }).sort({ created_at: -1 }).limit(30).select('order_number status total_rwf fulfillment created_at items').lean();
      result.orders = orders.map((o) => ({ id: String(o._id), order_number: o.order_number, status: o.status, total_rwf: o.total_rwf, fulfillment: o.fulfillment, created_at: o.created_at, items: (o.items || []).map((i) => `${i.quantity}× ${i.name}`) }));
    }
    if (kitchen.can('customers.loyalty')) result.loyalty_history = (c.loyalty_history || []).slice(-30).reverse();
    if (kitchen.can('customers.feedback')) {
      const fb = await Feedback.find({ vendor_id: kitchen.vendorId, $or: [{ customer_id: c.customer_id || null }, { order_id: { $in: (result.orders || []).map((o) => o.id) } }] }).sort({ created_at: -1 }).limit(10).lean();
      result.feedback = fb.map((f) => ({ id: String(f._id), rating: f.rating, comment: f.comment, created_at: f.created_at }));
    }
    return result;
  }

  async #parse(body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 80 });
    if (body.phone !== undefined) update.phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.email !== undefined) update.email = parseOptionalText(body.email, { field: 'email', max: 120 }) || '';
    if (body.notes !== undefined) update.notes = parseOptionalText(body.notes, { field: 'notes', max: 500 }) || '';
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 10) throw ApiError.badRequest('Up to 10 tags.', { tags: 'expected a list' });
      update.tags = [...new Set(body.tags.map((t) => String(t).trim().slice(0, 20)).filter(Boolean))];
    }
    return update;
  }

  async create(kitchen, body = {}) {
    kitchen.assert('customers.manage');
    const update = await this.#parse(body, { partial: false });
    if (update.phone && (await KitchenCustomer.exists({ vendor_id: kitchen.vendorId, phone: update.phone, deleted_at: null }))) {
      throw ApiError.conflict('A customer with this phone number is already in your list.', 'CUSTOMER_EXISTS');
    }
    const c = await KitchenCustomer.create({ ...update, vendor_id: kitchen.vendorId });
    await activity.record(kitchen, { action: 'customer.created', target_type: 'customer', target_id: c._id, summary: `Added customer ${c.name}` });
    return serialize(c.toObject());
  }

  async update(kitchen, customerId, body = {}) {
    const c = await this.#load(kitchen, customerId);
    const update = await this.#parse(body, { partial: true });
    if (Object.keys(update).length) kitchen.assert('customers.manage');
    if (body.discount_percent !== undefined) {
      kitchen.assert('customers.discounts');
      const n = Number(body.discount_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw ApiError.badRequest('The discount is 0 to 100%.', { discount_percent: 'expected 0-100' });
      update.discount_percent = Math.round(n * 10) / 10;
    }
    const saved = await KitchenCustomer.findOneAndUpdate({ _id: c._id }, { $set: update }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, { action: 'customer.updated', target_type: 'customer', target_id: c._id, summary: `Updated customer ${saved.name}`, details: { fields: Object.keys(update) } });
    return serialize(saved);
  }

  /** "Manage customer loyalty points": add or take away points by hand (with a reason). */
  async adjustPoints(kitchen, customerId, body = {}) {
    kitchen.assert('customers.loyalty');
    const c = await this.#load(kitchen, customerId);
    const points = Number(body.points);
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1000000) throw ApiError.badRequest('Points are a whole number, + or −.', { points: 'expected a non-zero integer' });
    const reason = parseRequiredText(body.reason, { field: 'reason', min: 2, max: 120 });
    const saved = await KitchenCustomer.findOneAndUpdate(
      { _id: c._id, ...(points < 0 ? { loyalty_points: { $gte: -points } } : {}) },
      { $inc: { loyalty_points: points }, $push: { loyalty_history: { points, reason, by: kitchen.actor.name } } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict(`${c.name} has only ${c.loyalty_points} points.`, 'NOT_ENOUGH_POINTS');
    await activity.record(kitchen, { action: 'customer.points', target_type: 'customer', target_id: c._id, summary: `${points > 0 ? '+' : ''}${points} points for ${c.name}: ${reason}` });
    return serialize(saved);
  }

  /** Earns the points of a paid bill, once (when loyalty is on and a customer is on the bill or the order). */
  async earnForInvoice(invoiceId) {
    const invoice = await Invoice.findById(invoiceId).lean();
    if (!invoice || invoice.status !== 'paid' || invoice.loyalty_points_earned) return;
    const vendor = await Vendor.findById(invoice.vendor_id).select('operations.loyalty').lean();
    const loyalty = vendor?.operations?.loyalty;
    if (!loyalty?.enabled) return;
    let customerId = invoice.kitchen_customer_id;
    if (!customerId && invoice.kind === 'order') {
      const order = await Order.findById(invoice.order_ids[0]).select('customer_id').lean();
      customerId = (await this.forAppCustomer(invoice.vendor_id, order?.customer_id))?._id;
    }
    if (!customerId) return;
    const points = Math.floor((invoice.amount_paid_rwf - (invoice.refunded_rwf || 0)) / (loyalty.earn_per_rwf || 1000));
    if (points <= 0) return;
    const claimed = await Invoice.findOneAndUpdate({ _id: invoice._id, loyalty_points_earned: 0 }, { $set: { loyalty_points_earned: points, kitchen_customer_id: customerId } });
    if (!claimed) return;
    await KitchenCustomer.updateOne({ _id: customerId }, { $inc: { loyalty_points: points }, $push: { loyalty_history: { points, reason: `Bill ${invoice.invoice_number}`, invoice_id: invoice._id, by: 'Automatic' } } });
  }

  /** Puts a kitchen customer on a table bill: their standing discount applies, points are earned. */
  async attachToInvoice(kitchen, invoiceId, body = {}) {
    if (!['invoices.edit', 'customers.loyalty', 'customers.discounts', 'invoices.process_payment'].some((p) => kitchen.can(p))) kitchen.assert('invoices.edit');
    const invoice = await Invoice.findOne({ _id: parseObjectId(invoiceId, 'invoice_id'), vendor_id: kitchen.vendorId }).lean();
    if (!invoice) throw ApiError.notFound('Invoice not found.', 'INVOICE_NOT_FOUND');
    if (!['unpaid', 'partially_paid'].includes(invoice.status)) throw ApiError.conflict('This bill is already settled.', 'INVOICE_SETTLED');
    const c = body.customer_id ? await this.#load(kitchen, body.customer_id) : null;
    const set = { kitchen_customer_id: c ? c._id : null, customer_name: c ? c.name : invoice.customer_name };
    if (c?.discount_percent && kitchen.can('customers.discounts')) {
      const lineTotal = invoice.lines.filter((l) => !l.voided).reduce((s, l) => s + l.subtotal_rwf, 0);
      set.discount_rwf = Math.max(invoice.discount_rwf || 0, Math.round((lineTotal * c.discount_percent) / 100));
    }
    await Invoice.updateOne({ _id: invoice._id }, { $set: set });
    await Order.updateMany({ _id: { $in: invoice.order_ids } }, { $set: { kitchen_customer_id: c ? c._id : null } });
    await require('./invoiceService').recalc(invoice._id);
    return require('./invoiceService').get(kitchen, invoice._id);
  }

  /** Spends a customer's points on their bill. */
  async redeemPoints(kitchen, invoiceId, body = {}) {
    kitchen.assert('customers.loyalty');
    const invoice = await Invoice.findOne({ _id: parseObjectId(invoiceId, 'invoice_id'), vendor_id: kitchen.vendorId }).lean();
    if (!invoice) throw ApiError.notFound('Invoice not found.', 'INVOICE_NOT_FOUND');
    if (!['unpaid', 'partially_paid'].includes(invoice.status) || !invoice.kitchen_customer_id) {
      throw ApiError.conflict('Put a customer on an unpaid bill first.', 'NO_CUSTOMER_ON_BILL');
    }
    const vendor = await Vendor.findById(kitchen.vendorId).select('operations.loyalty').lean();
    if (!vendor?.operations?.loyalty?.enabled) throw ApiError.conflict('Loyalty points are switched off (Operations settings).', 'LOYALTY_OFF');
    const value = vendor.operations.loyalty.point_value_rwf || 10;
    const points = Number(body.points);
    if (!Number.isInteger(points) || points <= 0) throw ApiError.badRequest('How many points?', { points: 'expected a positive integer' });
    const due = invoice.total_rwf - invoice.amount_paid_rwf;
    if (points * value > due) throw ApiError.badRequest(`At most ${Math.floor(due / value)} points on this bill.`, { points: 'more than the bill' });
    const customer = await KitchenCustomer.findOneAndUpdate(
      { _id: invoice.kitchen_customer_id, loyalty_points: { $gte: points } },
      { $inc: { loyalty_points: -points }, $push: { loyalty_history: { points: -points, reason: `Spent on ${invoice.invoice_number}`, invoice_id: invoice._id, by: kitchen.actor.name } } },
      { returnDocument: 'after' }
    ).lean();
    if (!customer) throw ApiError.conflict('Not enough points.', 'NOT_ENOUGH_POINTS');
    await Invoice.updateOne({ _id: invoice._id }, { $inc: { loyalty_points_redeemed: points, loyalty_discount_rwf: points * value } });
    const saved = await require('./invoiceService').recalc(invoice._id);
    await activity.record(kitchen, { action: 'invoice.points_redeemed', target_type: 'invoice', target_id: invoice._id, summary: `${customer.name} spent ${points} points (RWF ${(points * value).toLocaleString('en-US')}) on ${invoice.invoice_number}` });
    if (saved.status === 'paid') await require('./invoiceService').markPaid(saved);
    return require('./invoiceService').get(kitchen, invoice._id);
  }

  /** "Send customer notifications": an in-app message to app customers who ordered here. */
  async notify(kitchen, body = {}) {
    kitchen.assert('notifications.customer');
    const title = parseRequiredText(body.title, { field: 'title', min: 2, max: 80 });
    const text = parseRequiredText(body.body, { field: 'body', min: 2, max: 400 });
    const vendor = await Vendor.findById(kitchen.vendorId).select('name').lean();
    let customerIds;
    if (Array.isArray(body.customer_ids) && body.customer_ids.length) {
      const rows = await KitchenCustomer.find({ _id: { $in: body.customer_ids.filter((id) => mongoose.isValidObjectId(id)) }, vendor_id: kitchen.vendorId, customer_id: { $ne: null } }).select('customer_id').lean();
      customerIds = rows.map((r) => r.customer_id);
    } else {
      // Everyone who ordered in the last 90 days.
      customerIds = await Order.distinct('customer_id', { vendor_id: kitchen.vendorId, customer_id: { $ne: null }, created_at: { $gte: new Date(Date.now() - 90 * 86400000) } });
    }
    // At most 3 broadcasts a day, so customers aren't flooded.
    const today = await mongoose.model('KitchenActivity').countDocuments({ vendor_id: kitchen.vendorId, action: 'customer.notified', created_at: { $gte: new Date(Date.now() - 86400000) } });
    if (today >= 3) throw ApiError.tooMany('You can message customers 3 times a day at most.', 'CUSTOMER_NOTIFY_LIMIT');
    const recipients = customerIds.slice(0, 2000);
    await notificationService.notifyCustomers(recipients, { type: 'general', title: `${vendor.name}: ${title}`, body: text, link: `/vendor/${kitchen.vendorId}` });
    const sent = recipients.length;
    await activity.record(kitchen, { action: 'customer.notified', target_type: 'customer', summary: `Sent "${title}" to ${sent} customer${sent === 1 ? '' : 's'}` });
    return { sent };
  }

  // ----------------------------------------------------- feedback & reviews

  /** Public: a guest rates their order (once). */
  async leaveFeedback(order, body = {}) {
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw ApiError.badRequest('Rate from 1 to 5 stars.', { rating: 'expected 1-5' });
    try {
      const f = await Feedback.create({
        vendor_id: order.vendor_id,
        order_id: order._id,
        order_number: order.order_number,
        table_label: order.table?.label || '',
        customer_id: order.customer_id || null,
        name: order.guest?.name || '',
        rating,
        comment: parseOptionalText(body.comment, { field: 'comment', max: 500 }) || '',
        is_public: body.is_public === true,
      });
      return { id: String(f._id), rating: f.rating };
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('You already rated this order. Thank you!', 'FEEDBACK_EXISTS');
      throw error;
    }
  }

  #serializeFeedback(f) {
    return { id: String(f._id), order_number: f.order_number, table: f.table_label || null, name: f.name || 'Guest', rating: f.rating, comment: f.comment, is_public: f.is_public, reply: f.reply || '', replied_by: f.replied_by || '', created_at: f.created_at };
  }

  async listFeedback(kitchen, query = {}) {
    // Someone who may only see reviews gets the public ones.
    const reviewsOnly = query.public === 'true' || (!kitchen.can('customers.feedback') && kitchen.can('customers.reviews'));
    if (reviewsOnly) {
      if (!['customers.reviews', 'customers.feedback'].some((p) => kitchen.can(p))) kitchen.assert('customers.reviews');
    } else kitchen.assert('customers.feedback');
    const filter = { vendor_id: kitchen.vendorId, ...(reviewsOnly ? { is_public: true } : {}) };
    const rows = await Feedback.find(filter).sort({ created_at: -1 }).limit(100).lean();
    const all = await Feedback.aggregate([{ $match: { vendor_id: new ObjectId(kitchen.vendorId) } }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]);
    return { feedback: rows.map((f) => this.#serializeFeedback(f)), average_rating: all[0] ? Math.round(all[0].avg * 10) / 10 : null, count: all[0]?.n || 0 };
  }

  /** "Respond to customer complaints": a public reply on the feedback. */
  async reply(kitchen, feedbackId, body = {}) {
    kitchen.assert('customers.complaints');
    const reply = parseRequiredText(body.reply, { field: 'reply', min: 2, max: 500 });
    const saved = await Feedback.findOneAndUpdate(
      { _id: parseObjectId(feedbackId, 'feedback_id'), vendor_id: kitchen.vendorId },
      { $set: { reply, replied_by: kitchen.actor.name, replied_at: new Date() } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.notFound('Feedback not found.', 'FEEDBACK_NOT_FOUND');
    if (saved.customer_id) {
      notificationService.notifyCustomers([saved.customer_id], { type: 'general', title: 'The kitchen replied to your feedback', body: reply, link: '/orders' }).catch(() => null);
    }
    await activity.record(kitchen, { action: 'customer.feedback_replied', target_type: 'feedback', target_id: saved._id, summary: `Replied to ${saved.rating}-star feedback on ${saved.order_number}` });
    return this.#serializeFeedback(saved);
  }

  /** Public reviews for the kitchen's page. */
  async publicReviews(vendorId) {
    const rows = await Feedback.find({ vendor_id: vendorId, is_public: true }).sort({ created_at: -1 }).limit(20).lean();
    return rows.map((f) => ({ name: f.name || 'Guest', rating: f.rating, comment: f.comment, reply: f.reply || '', created_at: f.created_at }));
  }
}

module.exports = new CustomerService();

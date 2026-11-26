const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText, parseBooleanValue } = require('../../utils/vendorValidators');
const { Promotion, Invoice, MenuItem } = require('../../models');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;

const live = (p, now = new Date()) =>
  p.is_active && !p.deleted_at && (!p.starts_at || p.starts_at <= now) && (!p.ends_at || p.ends_at > now) && (!p.usage_limit || p.used_count < p.usage_limit);

const serialize = (p) => ({
  id: String(p._id),
  name: p.name,
  kind: p.kind,
  code: p.code || null,
  discount_type: p.discount_type,
  value: p.value,
  applies_to: p.applies_to,
  product_ids: (p.product_ids || []).map(String),
  department_ids: (p.department_ids || []).map(String),
  min_order_rwf: p.min_order_rwf || 0,
  starts_at: p.starts_at,
  ends_at: p.ends_at,
  usage_limit: p.usage_limit,
  used_count: p.used_count || 0,
  is_active: Boolean(p.is_active),
  is_live: live(p),
  created_at: p.created_at,
});

/** How much a promotion takes off these bill lines. */
function discountFor(promotion, lines) {
  const eligible = lines.filter((l) => {
    if (l.voided) return false;
    if (promotion.applies_to === 'products') return (promotion.product_ids || []).some((id) => String(id) === String(l.menu_item_id || ''));
    if (promotion.applies_to === 'departments') return (promotion.department_ids || []).some((id) => String(id) === String(l.department_id || ''));
    return true;
  });
  const base = eligible.reduce((s, l) => s + l.subtotal_rwf, 0);
  const all = lines.filter((l) => !l.voided).reduce((s, l) => s + l.subtotal_rwf, 0);
  if (!base || all < (promotion.min_order_rwf || 0)) return 0;
  const amount = promotion.discount_type === 'percent' ? Math.round((base * Math.min(100, promotion.value)) / 100) : Math.min(base, Math.round(promotion.value));
  return Math.max(0, amount);
}

/**
 * Discounts on bills the kitchen collects (dine-in tables). App orders are
 * priced and paid in the app, so promotions don't change them.
 */
class PromotionService {
  #needs(kitchen, kind, appliesTo, action) {
    kitchen.assert(`promotions.${action}`);
    kitchen.assert(kind === 'code' ? 'promotions.codes' : 'promotions.campaigns');
    if (appliesTo === 'products' && !kitchen.can('menu.promotions')) kitchen.assert('promotions.products');
    if (appliesTo === 'departments') kitchen.assert('promotions.departments');
  }

  async list(kitchen) {
    kitchen.assert('promotions.view');
    const rows = await Promotion.find({ vendor_id: kitchen.vendorId, deleted_at: null }).sort({ created_at: -1 }).lean();
    return { promotions: rows.map(serialize) };
  }

  async #parse(kitchen, body, current = null) {
    const p = {};
    const kind = current?.kind || body.kind;
    if (!['code', 'automatic'].includes(kind)) throw ApiError.badRequest('Is it a code or an automatic campaign?', { kind: 'expected code or automatic' });
    p.kind = kind;
    if (!current || body.name !== undefined) p.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
    if (kind === 'code' && (!current || body.code !== undefined)) {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw ApiError.badRequest('Codes are 3 to 20 letters or numbers, e.g. WELCOME10.', { code: 'expected 3-20 of A-Z 0-9 _ -' });
      p.code = code;
    }
    if (!current || body.discount_type !== undefined) {
      if (!['percent', 'amount'].includes(body.discount_type)) throw ApiError.badRequest('Percent or a fixed amount?', { discount_type: 'expected percent or amount' });
      p.discount_type = body.discount_type;
    }
    if (!current || body.value !== undefined) {
      const value = Number(body.value);
      const type = p.discount_type || current?.discount_type;
      if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100) || (type === 'amount' && !Number.isInteger(value))) {
        throw ApiError.badRequest(type === 'percent' ? 'The discount is 1 to 100%.' : 'The discount is a whole number of RWF.', { value: 'out of range' });
      }
      p.value = value;
    }
    if (!current || body.applies_to !== undefined) {
      p.applies_to = ['all', 'products', 'departments'].includes(body.applies_to) ? body.applies_to : 'all';
    }
    if (body.product_ids !== undefined) {
      const ids = Array.isArray(body.product_ids) ? [...new Set(body.product_ids.map(String))] : [];
      const found = await MenuItem.countDocuments({ _id: { $in: ids.filter((id) => mongoose.isValidObjectId(id)) }, vendor_id: kitchen.vendorId, deleted_at: null });
      if (found !== ids.length) throw ApiError.badRequest('Some products are not on your menu.', { product_ids: 'unknown product' });
      p.product_ids = ids.map((id) => new ObjectId(id));
    }
    if (body.department_ids !== undefined) p.department_ids = (await departmentService.resolveIds(kitchen.vendorId, body.department_ids)) || [];
    if (body.min_order_rwf !== undefined) {
      const n = Number(body.min_order_rwf || 0);
      if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest('The minimum order is whole RWF.', { min_order_rwf: 'expected an integer >= 0' });
      p.min_order_rwf = n;
    }
    for (const field of ['starts_at', 'ends_at']) {
      if (body[field] !== undefined) {
        if (!body[field]) p[field] = null;
        else {
          const d = new Date(body[field]);
          if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${field} is not a valid date.`, { [field]: 'expected a date' });
          p[field] = d;
        }
      }
    }
    if (body.usage_limit !== undefined) {
      const n = body.usage_limit === null || body.usage_limit === '' ? null : Number(body.usage_limit);
      if (n !== null && (!Number.isInteger(n) || n < 1)) throw ApiError.badRequest('The usage limit is at least 1.', { usage_limit: 'expected an integer >= 1' });
      p.usage_limit = n;
    }
    if (body.is_active !== undefined) p.is_active = parseBooleanValue(body.is_active, { field: 'is_active' });
    return p;
  }

  async create(kitchen, body = {}) {
    const p = await this.#parse(kitchen, body);
    this.#needs(kitchen, p.kind, p.applies_to, 'create');
    try {
      const saved = await Promotion.create({ ...p, vendor_id: kitchen.vendorId });
      await activity.record(kitchen, { action: 'promotion.created', target_type: 'promotion', target_id: saved._id, summary: `Created promotion ${saved.name}${saved.code ? ` (${saved.code})` : ''}` });
      if (saved.kind === 'automatic') await this.#refreshOpenBills(kitchen.vendorId);
      return serialize(saved.toObject());
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('That code is already used by another promotion.', 'PROMO_CODE_TAKEN');
      throw error;
    }
  }

  async update(kitchen, promotionId, body = {}) {
    const current = await Promotion.findOne({ _id: parseObjectId(promotionId, 'promotion_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!current) throw ApiError.notFound('Promotion not found.', 'PROMOTION_NOT_FOUND');
    const p = await this.#parse(kitchen, body, current);
    this.#needs(kitchen, current.kind, p.applies_to || current.applies_to, 'edit');
    try {
      const saved = await Promotion.findOneAndUpdate({ _id: current._id }, { $set: p }, { returnDocument: 'after' }).lean();
      if (saved.kind === 'automatic') await this.#refreshOpenBills(kitchen.vendorId);
      await activity.record(kitchen, { action: 'promotion.updated', target_type: 'promotion', target_id: saved._id, summary: `Updated promotion ${saved.name}` });
      return serialize(saved);
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('That code is already used by another promotion.', 'PROMO_CODE_TAKEN');
      throw error;
    }
  }

  async remove(kitchen, promotionId) {
    const current = await Promotion.findOne({ _id: parseObjectId(promotionId, 'promotion_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!current) throw ApiError.notFound('Promotion not found.', 'PROMOTION_NOT_FOUND');
    this.#needs(kitchen, current.kind, current.applies_to, 'delete');
    // The code is freed for a new promotion.
    await Promotion.updateOne({ _id: current._id }, { $set: { deleted_at: new Date(), is_active: false, code: null } });
    if (current.kind === 'automatic') await this.#refreshOpenBills(kitchen.vendorId);
    await activity.record(kitchen, { action: 'promotion.deleted', target_type: 'promotion', target_id: current._id, summary: `Deleted promotion ${current.name}` });
    return { deleted: true, id: String(current._id) };
  }

  /**
   * Works out the automatic campaigns on an open bill again (lines changed),
   * keeping the codes already applied.
   */
  async refreshInvoice(invoiceId) {
    const invoice = await Invoice.findById(invoiceId).lean();
    if (!invoice || invoice.kind !== 'table' || !['unpaid', 'partially_paid'].includes(invoice.status)) return;
    const campaigns = (await Promotion.find({ vendor_id: invoice.vendor_id, kind: 'automatic', deleted_at: null }).lean()).filter((p) => live(p));
    const codeIds = (invoice.promotions || []).filter((p) => p.code).map((p) => String(p.promotion_id));
    const codes = await Promotion.find({ _id: { $in: codeIds } }).lean();
    const applied = [];
    for (const promo of [...campaigns, ...codes]) {
      const amount = discountFor(promo, invoice.lines);
      if (amount > 0) applied.push({ promotion_id: promo._id, name: promo.name, code: promo.kind === 'code' ? promo.code : '', amount_rwf: amount });
    }
    const lineTotal = invoice.lines.filter((l) => !l.voided).reduce((s, l) => s + l.subtotal_rwf, 0);
    const total = Math.min(lineTotal, applied.reduce((s, a) => s + a.amount_rwf, 0));
    await Invoice.updateOne({ _id: invoice._id }, { $set: { promotions: applied, promo_discount_rwf: total } });
    await require('./invoiceService').recalc(invoice._id);
  }

  async #refreshOpenBills(vendorId) {
    const open = await Invoice.find({ vendor_id: vendorId, kind: 'table', status: { $in: ['unpaid', 'partially_paid'] } }).select('_id').lean();
    for (const invoice of open) await this.refreshInvoice(invoice._id);
  }

  /** "Create discount codes" in use: the cashier applies a guest's code to their bill. */
  async applyCode(kitchen, invoiceId, body = {}) {
    if (!['invoices.discounts', 'promotions.manual_discounts', 'invoices.process_payment', 'invoices.edit'].some((p) => kitchen.can(p))) kitchen.assert('invoices.discounts');
    const invoice = await Invoice.findOne({ _id: parseObjectId(invoiceId, 'invoice_id'), vendor_id: kitchen.vendorId }).lean();
    if (!invoice) throw ApiError.notFound('Invoice not found.', 'INVOICE_NOT_FOUND');
    if (invoice.kind !== 'table' || !['unpaid', 'partially_paid'].includes(invoice.status)) throw ApiError.conflict('Codes apply to unpaid table bills.', 'INVOICE_SETTLED');
    const code = String(body.code || '').trim().toUpperCase();
    const promo = await Promotion.findOne({ vendor_id: kitchen.vendorId, kind: 'code', code, deleted_at: null }).lean();
    if (!promo || !live(promo)) throw ApiError.badRequest('This code is not valid right now.', { code: 'unknown or expired' });
    if ((invoice.promotions || []).some((p) => String(p.promotion_id) === String(promo._id))) throw ApiError.conflict('This code is already on the bill.', 'CODE_ALREADY_APPLIED');
    const amount = discountFor(promo, invoice.lines);
    if (!amount) throw ApiError.conflict(promo.min_order_rwf ? `This code needs a bill of at least RWF ${promo.min_order_rwf.toLocaleString('en-US')} with eligible items.` : 'Nothing on this bill qualifies for the code.', 'CODE_NOT_APPLICABLE');
    // Counted atomically so a limited code can't be used more times than allowed.
    const counted = await Promotion.findOneAndUpdate(
      { _id: promo._id, ...(promo.usage_limit ? { used_count: { $lt: promo.usage_limit } } : {}) },
      { $inc: { used_count: 1 } }
    );
    if (!counted) throw ApiError.conflict('This code has been used up.', 'CODE_USED_UP');
    await Invoice.updateOne({ _id: invoice._id }, { $push: { promotions: { promotion_id: promo._id, name: promo.name, code: promo.code, amount_rwf: amount } } });
    await this.refreshInvoice(invoice._id);
    await activity.record(kitchen, { action: 'invoice.code_applied', target_type: 'invoice', target_id: invoice._id, summary: `Code ${promo.code} on ${invoice.invoice_number}` });
    return require('./invoiceService').get(kitchen, invoice._id);
  }

  /** Live automatic campaigns, for the menu ("10% off the bakery today"). */
  async publicCampaigns(vendorId) {
    const rows = (await Promotion.find({ vendor_id: vendorId, kind: 'automatic', deleted_at: null }).lean()).filter((p) => live(p));
    return rows.map((p) => ({
      name: p.name,
      label: p.discount_type === 'percent' ? `${p.value}% off` : `RWF ${p.value.toLocaleString('en-US')} off`,
      applies_to: p.applies_to,
      department_ids: (p.department_ids || []).map(String),
      product_ids: (p.product_ids || []).map(String),
      min_order_rwf: p.min_order_rwf || 0,
      ends_at: p.ends_at,
    }));
  }
}

module.exports = new PromotionService();
module.exports.discountFor = discountFor;

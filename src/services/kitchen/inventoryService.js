const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { InventoryItem, StockMovement, Supplier, MenuItem, Order } = require('../../models');
const notificationService = require('../notificationService');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const REASONS = ['purchase', 'adjustment', 'waste', 'usage', 'return'];
const round = (n) => Math.round(n * 1000) / 1000;

const parseQuantity = (raw, field, { allowNegative = false, allowZero = false } = {}) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > 10000000 || (!allowNegative && n < 0) || (!allowZero && n === 0)) {
    throw ApiError.badRequest(`${field} must be a number${allowNegative ? '' : ' above 0'}.`, { [field]: 'invalid quantity' });
  }
  return round(n);
};

function serializeItem(item, { departments = new Map(), suppliers = new Map() } = {}) {
  const low = item.low_stock_threshold > 0 && item.quantity <= item.low_stock_threshold;
  return {
    id: String(item._id),
    name: item.name,
    unit: item.unit,
    sku: item.sku || '',
    quantity: item.quantity,
    low_stock_threshold: item.low_stock_threshold,
    is_low: low,
    is_out: item.quantity <= 0,
    cost_per_unit_rwf: item.cost_per_unit_rwf || 0,
    stock_value_rwf: Math.round(Math.max(0, item.quantity) * (item.cost_per_unit_rwf || 0)),
    department_id: item.department_id ? String(item.department_id) : null,
    department_name: item.department_id ? departments.get(String(item.department_id))?.name || '' : 'Whole kitchen',
    supplier_id: item.supplier_id ? String(item.supplier_id) : null,
    supplier_name: item.supplier_id ? suppliers.get(String(item.supplier_id))?.name || '' : '',
    updated_at: item.updated_at,
  };
}

const serializeMovement = (m, items = new Map()) => ({
  id: String(m._id),
  item_id: String(m.item_id),
  item_name: items.get(String(m.item_id))?.name || '',
  unit: items.get(String(m.item_id))?.unit || '',
  delta: m.delta,
  quantity_after: m.quantity_after,
  reason: m.reason,
  note: m.note || '',
  order_number: m.order_number || null,
  by: m.actor?.name || '',
  at: m.created_at,
});

class InventoryService {
  async #context(vendorId) {
    const [departments, suppliers] = await Promise.all([
      departmentService.listForVendor(vendorId),
      Supplier.find({ vendor_id: vendorId, deleted_at: null }).lean(),
    ]);
    return {
      departments: new Map(departments.map((d) => [String(d._id), d])),
      suppliers: new Map(suppliers.map((s) => [String(s._id), s])),
    };
  }

  async list(kitchen, query = {}) {
    const filter = { vendor_id: kitchen.vendorId, deleted_at: null, ...kitchen.departmentFilter('inventory.view') };
    if (query.department_id === 'none') filter.department_id = null;
    else if (query.department_id && mongoose.isValidObjectId(query.department_id)) {
      kitchen.assert('inventory.view', query.department_id);
      filter.department_id = new ObjectId(query.department_id);
    }
    if (typeof query.q === 'string' && query.q.trim()) filter.name = { $regex: query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, ctx] = await Promise.all([InventoryItem.find(filter).sort({ name: 1 }).lean(), this.#context(kitchen.vendorId)]);
    let list = items.map((item) => serializeItem(item, ctx));
    if (query.low === 'true') list = list.filter((i) => i.is_low || i.is_out);
    return {
      items: list,
      summary: {
        count: list.length,
        low: list.filter((i) => i.is_low && !i.is_out).length,
        out: list.filter((i) => i.is_out).length,
        stock_value_rwf: list.reduce((sum, i) => sum + i.stock_value_rwf, 0),
      },
    };
  }

  async #load(kitchen, itemId, permission) {
    const id = parseObjectId(itemId, 'item_id');
    const item = await InventoryItem.findOne({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!item) throw ApiError.notFound('Stock item not found.', 'STOCK_ITEM_NOT_FOUND');
    kitchen.assert(permission, item.department_id ? String(item.department_id) : null);
    return item;
  }

  async #parse(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
    if (!partial || body.unit !== undefined) update.unit = parseRequiredText(body.unit || 'pcs', { field: 'unit', min: 1, max: 15 });
    if (body.sku !== undefined) update.sku = parseOptionalText(body.sku, { field: 'sku', max: 40 }) || '';
    if (body.low_stock_threshold !== undefined) update.low_stock_threshold = parseQuantity(body.low_stock_threshold || 0, 'low_stock_threshold', { allowZero: true });
    if (body.cost_per_unit_rwf !== undefined) {
      const cost = Number(body.cost_per_unit_rwf || 0);
      if (!Number.isInteger(cost) || cost < 0) throw ApiError.badRequest('The cost is a whole number of RWF.', { cost_per_unit_rwf: 'expected an integer >= 0' });
      update.cost_per_unit_rwf = cost;
    }
    if (body.department_id !== undefined) update.department_id = await departmentService.resolveId(kitchen.vendorId, body.department_id);
    if (body.supplier_id !== undefined) {
      if (!body.supplier_id) update.supplier_id = null;
      else {
        const id = parseObjectId(body.supplier_id, 'supplier_id');
        if (!(await Supplier.exists({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }))) {
          throw ApiError.badRequest('That supplier is not in your list.', { supplier_id: 'unknown supplier' });
        }
        update.supplier_id = id;
      }
    }
    return update;
  }

  async create(kitchen, body = {}) {
    const update = await this.#parse(kitchen, body, { partial: false });
    kitchen.assert('inventory.add', update.department_id ? String(update.department_id) : null);
    const quantity = body.quantity !== undefined && body.quantity !== '' ? parseQuantity(body.quantity, 'quantity', { allowZero: true }) : 0;
    const item = await InventoryItem.create({ ...update, vendor_id: kitchen.vendorId, quantity });
    if (quantity) {
      await StockMovement.create({ vendor_id: kitchen.vendorId, item_id: item._id, department_id: item.department_id, delta: quantity, quantity_after: quantity, reason: 'initial', actor: kitchen.actor });
    }
    await activity.record(kitchen, { action: 'inventory.item_created', target_type: 'inventory', target_id: item._id, summary: `Added stock item ${item.name}`, department_id: item.department_id });
    return serializeItem(item.toObject(), await this.#context(kitchen.vendorId));
  }

  async update(kitchen, itemId, body = {}) {
    const item = await this.#load(kitchen, itemId, 'inventory.update');
    const update = await this.#parse(kitchen, body, { partial: true });
    if (update.department_id !== undefined) kitchen.assert('inventory.update', update.department_id ? String(update.department_id) : null);
    const saved = await InventoryItem.findOneAndUpdate({ _id: item._id }, { $set: update }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, { action: 'inventory.item_updated', target_type: 'inventory', target_id: item._id, summary: `Updated stock item ${saved.name}` });
    return serializeItem(saved, await this.#context(kitchen.vendorId));
  }

  async remove(kitchen, itemId) {
    const item = await this.#load(kitchen, itemId, 'inventory.remove');
    await InventoryItem.updateOne({ _id: item._id }, { $set: { deleted_at: new Date() } });
    await MenuItem.updateMany({ vendor_id: kitchen.vendorId }, { $pull: { recipe: { inventory_item_id: item._id } } });
    await activity.record(kitchen, { action: 'inventory.item_removed', target_type: 'inventory', target_id: item._id, summary: `Removed stock item ${item.name}` });
    return { deleted: true, id: String(item._id) };
  }

  /** Atomic change of a stock level, written to the movement history. */
  async #move(vendorId, item, delta, { reason, note = '', actor, order = null, supplierId = null }) {
    const saved = await InventoryItem.findOneAndUpdate({ _id: item._id, deleted_at: null }, { $inc: { quantity: delta } }, { returnDocument: 'after' }).lean();
    if (!saved) return null;
    const fixed = round(saved.quantity);
    if (fixed !== saved.quantity) await InventoryItem.updateOne({ _id: item._id }, { $set: { quantity: fixed } });
    await StockMovement.create({
      vendor_id: vendorId,
      item_id: item._id,
      department_id: item.department_id || null,
      delta,
      quantity_after: fixed,
      reason,
      note,
      order_id: order?._id || null,
      order_number: order?.order_number || '',
      supplier_id: supplierId,
      actor,
    });
    await this.#lowStockAlert({ ...saved, quantity: fixed });
    return { ...saved, quantity: fixed };
  }

  /** Tells the kitchen once when an item falls to its low-stock level (again after it was restocked). */
  async #lowStockAlert(item) {
    const low = item.low_stock_threshold > 0 && item.quantity <= item.low_stock_threshold;
    if (low && !item.low_stock_alerted_at) {
      const claimed = await InventoryItem.findOneAndUpdate({ _id: item._id, low_stock_alerted_at: null }, { $set: { low_stock_alerted_at: new Date() } });
      if (claimed) {
        notificationService
          .notifyVendor(item.vendor_id, {
            type: 'general',
            title: item.quantity <= 0 ? `${item.name} is out of stock` : `${item.name} is running low`,
            body: `${item.quantity} ${item.unit} left (alert level ${item.low_stock_threshold} ${item.unit}).`,
            link: '/vendor-dashboard/inventory',
          })
          .catch(() => null);
      }
    } else if (!low && item.low_stock_alerted_at) {
      await InventoryItem.updateOne({ _id: item._id }, { $set: { low_stock_alerted_at: null } });
    }
  }

  /** POST /vendor/inventory/:id/adjust — stock in (purchase, return), out (waste, usage) or a correction. */
  async adjust(kitchen, itemId, body = {}) {
    const reason = String(body.reason || 'adjustment');
    if (!REASONS.includes(reason)) throw ApiError.badRequest('Pick why the stock changed.', { reason: `expected one of: ${REASONS.join(', ')}` });
    const outgoing = reason === 'waste' || reason === 'usage';
    const incoming = reason === 'purchase' || reason === 'return';
    let delta = parseQuantity(body.delta ?? body.quantity, 'delta', { allowNegative: reason === 'adjustment' });
    if (outgoing) delta = -Math.abs(delta);
    if (incoming) delta = Math.abs(delta);
    const item = await this.#load(kitchen, itemId, delta < 0 ? 'inventory.remove' : 'inventory.update');
    if (incoming && reason === 'purchase') kitchen.assert('inventory.add', item.department_id ? String(item.department_id) : null);
    let supplierId = null;
    if (body.supplier_id) {
      supplierId = parseObjectId(body.supplier_id, 'supplier_id');
      if (!(await Supplier.exists({ _id: supplierId, vendor_id: kitchen.vendorId, deleted_at: null }))) {
        throw ApiError.badRequest('That supplier is not in your list.', { supplier_id: 'unknown supplier' });
      }
    }
    const note = parseOptionalText(body.note, { field: 'note', max: 200 }) || '';
    const saved = await this.#move(kitchen.vendorId, item, delta, { reason, note, actor: kitchen.actor, supplierId });
    await activity.record(kitchen, {
      action: 'inventory.adjusted',
      target_type: 'inventory',
      target_id: item._id,
      summary: `${delta > 0 ? '+' : ''}${delta} ${item.unit} ${item.name} (${reason})`,
      department_id: item.department_id,
    });
    return serializeItem(saved, await this.#context(kitchen.vendorId));
  }

  async movements(kitchen, query = {}) {
    kitchen.assert('inventory.view');
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 200 });
    const filter = { vendor_id: kitchen.vendorId, ...kitchen.departmentFilter('inventory.view') };
    if (query.item_id && mongoose.isValidObjectId(query.item_id)) filter.item_id = new ObjectId(query.item_id);
    if (REASONS.concat(['order', 'initial']).includes(query.reason)) filter.reason = query.reason;
    const [rows, total] = await Promise.all([
      StockMovement.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      StockMovement.countDocuments(filter),
    ]);
    const items = await InventoryItem.find({ _id: { $in: rows.map((r) => r.item_id) } }).select('name unit').lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    return { movements: rows.map((m) => serializeMovement(m, byId)), meta: { page, limit, total } };
  }

  /**
   * A department finished a ticket: if the kitchen deducts stock
   * automatically, each dish's recipe comes off the shelf. Runs once per
   * ticket (stock_deducted_at), and only for dishes that have a recipe.
   */
  async deductForTicket(vendor, order, ticket) {
    if (!vendor?.operations?.inventory_auto_deduct) return;
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, tickets: { $elemMatch: { _id: ticket._id, stock_deducted_at: null } } },
      { $set: { 'tickets.$.stock_deducted_at': new Date() } }
    );
    if (!claimed) return;
    const lines = order.items.filter((item) => String(item.ticket_id) === String(ticket._id) && item.menu_item_id);
    const dishes = await MenuItem.find({ _id: { $in: lines.map((l) => l.menu_item_id) } }).select('recipe').lean();
    const recipeOf = new Map(dishes.map((d) => [String(d._id), d.recipe || []]));
    const totals = new Map();
    for (const line of lines) {
      for (const part of recipeOf.get(String(line.menu_item_id)) || []) {
        const key = String(part.inventory_item_id);
        totals.set(key, (totals.get(key) || 0) + part.quantity * line.quantity);
      }
    }
    if (!totals.size) return;
    const items = await InventoryItem.find({ _id: { $in: [...totals.keys()] }, vendor_id: vendor._id, deleted_at: null }).lean();
    for (const item of items) {
      await this.#move(vendor._id, item, -round(totals.get(String(item._id))), {
        reason: 'order',
        note: `${ticket.code} (${ticket.department_name})`,
        actor: { type: 'system', id: null, name: 'Automatic (recipe)' },
        order,
      });
    }
  }

  /** PUT /vendor/menu/:id/recipe — what one portion of a dish uses. */
  async setRecipe(kitchen, menuItemId, body = {}) {
    const id = parseObjectId(menuItemId, 'item_id');
    const dish = await MenuItem.findOne({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!dish) throw ApiError.notFound('Menu item not found.', 'MENU_ITEM_NOT_FOUND');
    kitchen.assert('menu.edit', dish.department_id ? String(dish.department_id) : null);
    if (!Array.isArray(body.recipe) || body.recipe.length > 30) {
      throw ApiError.badRequest('recipe must be a list of at most 30 ingredients.', { recipe: 'expected a list' });
    }
    const recipe = body.recipe.map((part, index) => ({
      inventory_item_id: parseObjectId(part?.inventory_item_id, `recipe[${index}].inventory_item_id`),
      quantity: parseQuantity(part?.quantity, `recipe[${index}].quantity`),
    }));
    const ids = [...new Set(recipe.map((r) => String(r.inventory_item_id)))];
    if (ids.length !== recipe.length) throw ApiError.badRequest('Each ingredient appears once.', { recipe: 'duplicate ingredient' });
    const found = await InventoryItem.countDocuments({ _id: { $in: ids }, vendor_id: kitchen.vendorId, deleted_at: null });
    if (found !== ids.length) throw ApiError.badRequest('Some ingredients are not in your stock list.', { recipe: 'unknown stock item' });
    await MenuItem.updateOne({ _id: dish._id }, { $set: { recipe } });
    await activity.record(kitchen, { action: 'menu.recipe_set', target_type: 'menu_item', target_id: dish._id, summary: `Set the recipe of ${dish.name} (${recipe.length} ingredients)` });
    return { menu_item_id: String(dish._id), recipe: recipe.map((r) => ({ inventory_item_id: String(r.inventory_item_id), quantity: r.quantity })) };
  }

  // ------------------------------------------------------------ suppliers

  async listSuppliers(kitchen) {
    const rows = await Supplier.find({ vendor_id: kitchen.vendorId, deleted_at: null }).sort({ name: 1 }).lean();
    return { suppliers: rows.map((s) => ({ id: String(s._id), name: s.name, contact_name: s.contact_name, phone: s.phone, email: s.email, notes: s.notes })) };
  }

  #parseSupplier(body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 80 });
    for (const [field, max] of [['contact_name', 80], ['phone', 20], ['email', 120], ['notes', 300]]) {
      if (body[field] !== undefined) update[field] = parseOptionalText(body[field], { field, max }) || '';
    }
    return update;
  }

  async createSupplier(kitchen, body = {}) {
    const supplier = await Supplier.create({ ...this.#parseSupplier(body, { partial: false }), vendor_id: kitchen.vendorId });
    await activity.record(kitchen, { action: 'supplier.created', target_type: 'supplier', target_id: supplier._id, summary: `Added supplier ${supplier.name}` });
    return (await this.listSuppliers(kitchen)).suppliers.find((s) => s.id === String(supplier._id));
  }

  async updateSupplier(kitchen, supplierId, body = {}) {
    const id = parseObjectId(supplierId, 'supplier_id');
    const saved = await Supplier.findOneAndUpdate({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }, { $set: this.#parseSupplier(body, { partial: true }) }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.notFound('Supplier not found.', 'SUPPLIER_NOT_FOUND');
    return (await this.listSuppliers(kitchen)).suppliers.find((s) => s.id === String(saved._id));
  }

  async removeSupplier(kitchen, supplierId) {
    const id = parseObjectId(supplierId, 'supplier_id');
    const saved = await Supplier.findOneAndUpdate({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }, { $set: { deleted_at: new Date() } }).lean();
    if (!saved) throw ApiError.notFound('Supplier not found.', 'SUPPLIER_NOT_FOUND');
    await InventoryItem.updateMany({ vendor_id: kitchen.vendorId, supplier_id: id }, { $set: { supplier_id: null } });
    await activity.record(kitchen, { action: 'supplier.removed', target_type: 'supplier', target_id: id, summary: `Removed supplier ${saved.name}` });
    return { deleted: true, id: String(id) };
  }
}

module.exports = new InventoryService();

const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const access = require('../../config/kitchenAccess');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { InventoryItem, StockMovement, Supplier, MenuItem, Order, PurchaseOrder, Counter } = require('../../models');
const notificationService = require('../notificationService');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const REASONS = ['purchase', 'adjustment', 'waste', 'usage', 'return'];
// Which kind of stock item each specialised permission covers.
const KIND_PERMISSION = { ingredient: 'inventory.ingredients', raw_material: 'inventory.raw_materials' };
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
    category: item.category || '',
    kind: item.kind || 'ingredient',
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
    const filter = { vendor_id: kitchen.vendorId, deleted_at: null, ...kitchen.departmentFilterAny(access.inGroup('inventory')) };
    if (query.department_id === 'none') filter.department_id = null;
    else if (query.department_id && mongoose.isValidObjectId(query.department_id)) {
      kitchen.assert('inventory.view', query.department_id);
      filter.department_id = new ObjectId(query.department_id);
    }
    if (typeof query.category === 'string' && query.category) filter.category = query.category;
    if (['ingredient', 'raw_material', 'supply'].includes(query.kind)) filter.kind = query.kind;
    if (typeof query.q === 'string' && query.q.trim()) filter.name = { $regex: query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, ctx] = await Promise.all([InventoryItem.find(filter).sort({ name: 1 }).lean(), this.#context(kitchen.vendorId)]);
    let list = items.map((item) => serializeItem(item, ctx));
    if (query.low === 'true') list = list.filter((i) => i.is_low || i.is_out);
    const categories = await InventoryItem.distinct('category', { vendor_id: kitchen.vendorId, deleted_at: null, category: { $ne: '' } });
    return {
      items: list,
      categories: categories.sort(),
      summary: {
        count: list.length,
        low: list.filter((i) => i.is_low && !i.is_out).length,
        out: list.filter((i) => i.is_out).length,
        stock_value_rwf: list.reduce((sum, i) => sum + i.stock_value_rwf, 0),
      },
    };
  }

  /** The stock item, if the person holds any of `permissions` for its department. */
  async #load(kitchen, itemId, permissions) {
    const id = parseObjectId(itemId, 'item_id');
    const item = await InventoryItem.findOne({ _id: id, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!item) throw ApiError.notFound('Stock item not found.', 'STOCK_ITEM_NOT_FOUND');
    const list = [].concat(permissions);
    const department = item.department_id ? String(item.department_id) : null;
    if (!list.some((permission) => kitchen.can(permission, department))) kitchen.assert(list[0], department);
    return item;
  }

  async #parse(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
    if (!partial || body.unit !== undefined) update.unit = parseRequiredText(body.unit || 'pcs', { field: 'unit', min: 1, max: 15 });
    if (body.sku !== undefined) update.sku = parseOptionalText(body.sku, { field: 'sku', max: 40 }) || '';
    if (body.category !== undefined) {
      update.category = parseOptionalText(body.category, { field: 'category', max: 40 }) || '';
      if (update.category && !kitchen.can('inventory.categories') && !kitchen.isAdmin) {
        const known = await InventoryItem.exists({ vendor_id: kitchen.vendorId, deleted_at: null, category: update.category });
        if (!known) kitchen.assert('inventory.categories');
      }
    }
    if (body.kind !== undefined) {
      if (!['ingredient', 'raw_material', 'supply'].includes(body.kind)) throw ApiError.badRequest('kind is ingredient, raw_material or supply.', { kind: 'invalid' });
      update.kind = body.kind;
    }
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
    // "Add stock" covers every item; "Ingredients" / "Raw materials" cover their own kind.
    const dept = update.department_id ? String(update.department_id) : null;
    const byKind = KIND_PERMISSION[update.kind || 'ingredient'];
    if (!kitchen.can('inventory.add', dept) && !(byKind && kitchen.can(byKind, dept))) kitchen.assert('inventory.add', dept);
    const quantity = body.quantity !== undefined && body.quantity !== '' ? parseQuantity(body.quantity, 'quantity', { allowZero: true }) : 0;
    const item = await InventoryItem.create({ ...update, vendor_id: kitchen.vendorId, quantity });
    if (quantity) {
      await StockMovement.create({ vendor_id: kitchen.vendorId, item_id: item._id, department_id: item.department_id, delta: quantity, quantity_after: quantity, reason: 'initial', actor: kitchen.actor });
    }
    await activity.record(kitchen, { action: 'inventory.item_created', target_type: 'inventory', target_id: item._id, summary: `Added stock item ${item.name}`, department_id: item.department_id });
    return serializeItem(item.toObject(), await this.#context(kitchen.vendorId));
  }

  async update(kitchen, itemId, body = {}) {
    const update = await this.#parse(kitchen, body, { partial: true });
    // Only the alert level changing: "Set low-stock alerts" is enough.
    const onlyAlert = Object.keys(update).length > 0 && Object.keys(update).every((key) => key === 'low_stock_threshold');
    const current = await InventoryItem.findOne({ _id: parseObjectId(itemId, 'item_id'), vendor_id: kitchen.vendorId, deleted_at: null }).select('kind').lean();
    const byKind = KIND_PERMISSION[current?.kind || 'ingredient'];
    const nothing = !Object.keys(update).length;
    const item = await this.#load(kitchen, itemId, onlyAlert || nothing ? ['inventory.low_stock_alerts', 'inventory.update', ...(byKind ? [byKind] : [])] : ['inventory.update', ...(byKind ? [byKind] : [])]);
    // Changing an item into another kind needs that kind too (or "Update stock").
    if (update.kind && update.kind !== item.kind && !kitchen.can('inventory.update', item.department_id ? String(item.department_id) : null)) {
      const target = KIND_PERMISSION[update.kind];
      if (!target || !kitchen.can(target)) kitchen.assert('inventory.update');
    }
    if (update.department_id !== undefined) kitchen.assert('inventory.update', update.department_id ? String(update.department_id) : null);
    const saved = await InventoryItem.findOneAndUpdate({ _id: item._id }, { $set: update }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, { action: 'inventory.item_updated', target_type: 'inventory', target_id: item._id, summary: `Updated stock item ${saved.name}` });
    return serializeItem(saved, await this.#context(kitchen.vendorId));
  }

  async remove(kitchen, itemId) {
    const item = await this.#load(kitchen, itemId, ['inventory.remove']);
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
        require('./alertService').emit(item.vendor_id, 'stock', {
          title: item.quantity <= 0 ? `${item.name} is out of stock` : `${item.name} is running low`,
          body: `${item.quantity} ${item.unit} left`,
          link: '/vendor-dashboard/inventory',
          permission: 'inventory.view_alerts',
        });
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
    // What happened decides which permission it takes.
    const NEEDS = {
      purchase: ['inventory.receive_deliveries', 'inventory.add', 'inventory.adjust'],
      return: ['inventory.add', 'inventory.adjust'],
      waste: ['inventory.waste', 'inventory.remove', 'inventory.adjust'],
      usage: ['inventory.remove', 'inventory.adjust'],
      adjustment: ['inventory.adjust', 'inventory.update'],
    };
    const item = await this.#load(kitchen, itemId, NEEDS[reason]);
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
    if (!['inventory.movements', 'inventory.view'].some((p) => kitchen.can(p))) kitchen.assert('inventory.movements');
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 200 });
    const filter = { vendor_id: kitchen.vendorId, ...kitchen.departmentFilter(kitchen.can('inventory.view') ? 'inventory.view' : 'inventory.movements') };
    if (query.item_id && mongoose.isValidObjectId(query.item_id)) filter.item_id = new ObjectId(query.item_id);
    if (REASONS.concat(['order', 'initial', 'transfer_in', 'transfer_out']).includes(query.reason)) filter.reason = query.reason;
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
    const dishDepartment = dish.department_id ? String(dish.department_id) : null;
    if (!['menu.edit', 'inventory.ingredients'].some((p) => kitchen.can(p, dishDepartment))) kitchen.assert('menu.edit', dishDepartment);
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

  // ------------------------------------------------------------ stock categories

  /** "Manage stock categories": rename one (every item in it follows) or clear it. */
  async renameCategory(kitchen, body = {}) {
    kitchen.assert('inventory.categories');
    const from = parseRequiredText(body.from, { field: 'from', min: 1, max: 40 });
    const to = parseOptionalText(body.to, { field: 'to', max: 40 }) || '';
    const result = await InventoryItem.updateMany({ vendor_id: kitchen.vendorId, deleted_at: null, category: from }, { $set: { category: to } });
    await activity.record(kitchen, { action: 'inventory.category_changed', target_type: 'inventory', summary: to ? `Renamed stock category ${from} to ${to}` : `Removed stock category ${from}` });
    return { updated: result.modifiedCount };
  }

  // ------------------------------------------------------------ transfers

  /**
   * "Manage stock transfers between departments": moves a quantity to the
   * same item in another department (created there if it doesn't exist).
   */
  async transfer(kitchen, itemId, body = {}) {
    const item = await this.#load(kitchen, itemId, ['inventory.transfers']);
    const target = await departmentService.resolveId(kitchen.vendorId, body.to_department_id ?? null);
    if (String(target || '') === String(item.department_id || '')) throw ApiError.badRequest('Pick another department.', { to_department_id: 'same department' });
    kitchen.assert('inventory.transfers', target ? String(target) : null);
    const quantity = parseQuantity(body.quantity, 'quantity');
    if (quantity > item.quantity) throw ApiError.conflict(`Only ${item.quantity} ${item.unit} in stock.`, 'NOT_ENOUGH_STOCK');
    let counterpart = await InventoryItem.findOne({ vendor_id: kitchen.vendorId, deleted_at: null, department_id: target, name: item.name, unit: item.unit }).lean();
    if (!counterpart) {
      counterpart = (
        await InventoryItem.create({
          vendor_id: kitchen.vendorId,
          department_id: target,
          name: item.name,
          unit: item.unit,
          sku: item.sku,
          category: item.category,
          kind: item.kind,
          cost_per_unit_rwf: item.cost_per_unit_rwf,
          low_stock_threshold: item.low_stock_threshold,
          supplier_id: item.supplier_id,
        })
      ).toObject();
    }
    // Atomic: the source can't go below zero even with two transfers at once.
    const taken = await InventoryItem.findOneAndUpdate({ _id: item._id, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } }, { returnDocument: 'after' }).lean();
    if (!taken) throw ApiError.conflict('The stock changed meanwhile. Refresh and try again.', 'STOCK_CHANGED');
    const note = parseOptionalText(body.note, { field: 'note', max: 200 }) || '';
    await StockMovement.create({ vendor_id: kitchen.vendorId, item_id: item._id, department_id: item.department_id, delta: -quantity, quantity_after: round(taken.quantity), reason: 'transfer_out', note, actor: kitchen.actor });
    await this.#move(kitchen.vendorId, counterpart, quantity, { reason: 'transfer_in', note, actor: kitchen.actor });
    await this.#lowStockAlert({ ...taken, quantity: round(taken.quantity) });
    await activity.record(kitchen, { action: 'inventory.transferred', target_type: 'inventory', target_id: item._id, summary: `Moved ${quantity} ${item.unit} ${item.name} to another department` });
    return { from: serializeItem(taken, await this.#context(kitchen.vendorId)), to_item_id: String(counterpart._id) };
  }

  // ------------------------------------------------------------ purchase orders

  #serializePo(po, suppliers = new Map()) {
    return {
      id: String(po._id),
      number: po.number,
      status: po.status,
      supplier_id: po.supplier_id ? String(po.supplier_id) : null,
      supplier_name: po.supplier_id ? suppliers.get(String(po.supplier_id))?.name || '' : '',
      lines: po.lines.map((l) => ({ id: String(l._id), item_id: String(l.item_id), name: l.name, unit: l.unit, quantity: l.quantity, unit_cost_rwf: l.unit_cost_rwf, received_quantity: l.received_quantity })),
      total_rwf: po.total_rwf,
      expected_at: po.expected_at,
      notes: po.notes || '',
      created_by: po.created_by?.name || '',
      created_at: po.created_at,
      sent_at: po.sent_at,
      received_at: po.received_at,
    };
  }

  async listPurchaseOrders(kitchen, query = {}) {
    if (!['inventory.purchase_orders', 'inventory.receive_deliveries'].some((p) => kitchen.can(p))) kitchen.assert('inventory.purchase_orders');
    const filter = { vendor_id: kitchen.vendorId };
    if (['draft', 'sent', 'partially_received', 'received', 'cancelled'].includes(query.status)) filter.status = query.status;
    const [rows, ctx] = await Promise.all([PurchaseOrder.find(filter).sort({ created_at: -1 }).limit(100).lean(), this.#context(kitchen.vendorId)]);
    return { purchase_orders: rows.map((po) => this.#serializePo(po, ctx.suppliers)) };
  }

  async #parsePoLines(kitchen, raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 50) throw ApiError.badRequest('Add 1 to 50 items.', { lines: 'expected a list' });
    const items = await InventoryItem.find({ _id: { $in: raw.map((l) => l?.item_id).filter((id) => mongoose.isValidObjectId(id)) }, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    return raw.map((line, index) => {
      const item = byId.get(String(line?.item_id));
      if (!item) throw ApiError.badRequest('Some items are not in your stock list.', { [`lines[${index}].item_id`]: 'unknown stock item' });
      const cost = Number(line.unit_cost_rwf ?? item.cost_per_unit_rwf ?? 0);
      if (!Number.isInteger(cost) || cost < 0) throw ApiError.badRequest('Costs are whole RWF.', { [`lines[${index}].unit_cost_rwf`]: 'expected an integer >= 0' });
      return { item_id: item._id, name: item.name, unit: item.unit, quantity: parseQuantity(line.quantity, `lines[${index}].quantity`), unit_cost_rwf: cost, received_quantity: 0 };
    });
  }

  async createPurchaseOrder(kitchen, body = {}) {
    kitchen.assert('inventory.purchase_orders');
    const lines = await this.#parsePoLines(kitchen, body.lines);
    let supplierId = null;
    if (body.supplier_id) {
      supplierId = parseObjectId(body.supplier_id, 'supplier_id');
      if (!(await Supplier.exists({ _id: supplierId, vendor_id: kitchen.vendorId, deleted_at: null }))) throw ApiError.badRequest('That supplier is not in your list.', { supplier_id: 'unknown supplier' });
    }
    const po = await PurchaseOrder.create({
      vendor_id: kitchen.vendorId,
      number: `PO-${String(await Counter.next(`po:${kitchen.vendorId}`)).padStart(4, '0')}`,
      supplier_id: supplierId,
      lines,
      total_rwf: Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_cost_rwf, 0)),
      expected_at: body.expected_at ? new Date(body.expected_at) : null,
      notes: parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '',
      created_by: kitchen.actor,
    });
    await activity.record(kitchen, { action: 'inventory.po_created', target_type: 'purchase_order', target_id: po._id, summary: `Created purchase order ${po.number}` });
    return this.#serializePo(po.toObject(), (await this.#context(kitchen.vendorId)).suppliers);
  }

  async updatePurchaseOrder(kitchen, poId, body = {}) {
    kitchen.assert('inventory.purchase_orders');
    const po = await PurchaseOrder.findOne({ _id: parseObjectId(poId, 'purchase_order_id'), vendor_id: kitchen.vendorId }).lean();
    if (!po) throw ApiError.notFound('Purchase order not found.', 'PO_NOT_FOUND');
    const set = {};
    if (body.status === 'sent' && po.status === 'draft') Object.assign(set, { status: 'sent', sent_at: new Date() });
    else if (body.status === 'cancelled' && ['draft', 'sent'].includes(po.status)) set.status = 'cancelled';
    else if (body.status !== undefined) throw ApiError.conflict(`A ${po.status} purchase order can't become ${body.status}.`, 'PO_INVALID_STATUS');
    if (body.lines !== undefined) {
      if (po.status !== 'draft') throw ApiError.conflict('Only a draft purchase order can change its items.', 'PO_NOT_DRAFT');
      set.lines = await this.#parsePoLines(kitchen, body.lines);
      set.total_rwf = Math.round(set.lines.reduce((s, l) => s + l.quantity * l.unit_cost_rwf, 0));
    }
    if (body.notes !== undefined) set.notes = parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '';
    const saved = await PurchaseOrder.findOneAndUpdate({ _id: po._id }, { $set: set }, { returnDocument: 'after' }).lean();
    return this.#serializePo(saved, (await this.#context(kitchen.vendorId)).suppliers);
  }

  /**
   * "Receive stock deliveries": what arrived goes into stock (each line once
   * up to what was ordered), and the cost is recorded as an expense.
   */
  async receivePurchaseOrder(kitchen, poId, body = {}) {
    if (!['inventory.receive_deliveries', 'inventory.purchase_orders'].some((p) => kitchen.can(p))) kitchen.assert('inventory.receive_deliveries');
    const po = await PurchaseOrder.findOne({ _id: parseObjectId(poId, 'purchase_order_id'), vendor_id: kitchen.vendorId }).lean();
    if (!po) throw ApiError.notFound('Purchase order not found.', 'PO_NOT_FOUND');
    if (!['draft', 'sent', 'partially_received'].includes(po.status)) throw ApiError.conflict(`This purchase order is ${po.status}.`, 'PO_CLOSED');
    const wanted = Array.isArray(body.lines) && body.lines.length ? body.lines : po.lines.map((l) => ({ line_id: String(l._id), quantity: l.quantity - l.received_quantity }));
    let cost = 0;
    const lines = po.lines.map((l) => ({ ...l }));
    for (const entry of wanted) {
      const line = lines.find((l) => String(l._id) === String(entry.line_id));
      if (!line) continue;
      const quantity = Math.min(parseQuantity(entry.quantity, 'quantity', { allowZero: true }), round(line.quantity - line.received_quantity));
      if (quantity <= 0) continue;
      const item = await InventoryItem.findOne({ _id: line.item_id, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
      if (!item) continue;
      await this.#move(kitchen.vendorId, item, quantity, { reason: 'purchase', note: po.number, actor: kitchen.actor, supplierId: po.supplier_id });
      await StockMovement.updateOne({ item_id: item._id, note: po.number }, { $set: { purchase_order_id: po._id } });
      line.received_quantity = round(line.received_quantity + quantity);
      cost += quantity * line.unit_cost_rwf;
    }
    if (!cost && !lines.some((l, i) => l.received_quantity !== po.lines[i].received_quantity)) throw ApiError.badRequest('Nothing to receive.', { lines: 'nothing left on this order' });
    const complete = lines.every((l) => l.received_quantity >= l.quantity);
    const saved = await PurchaseOrder.findOneAndUpdate(
      { _id: po._id, updated_at: po.updated_at },
      { $set: { lines, status: complete ? 'received' : 'partially_received', ...(complete ? { received_at: new Date() } : {}) } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This purchase order was just updated. Refresh and check the stock.', 'PO_CHANGED');
    await require('./financeService').recordPurchase(kitchen.vendorId, {
      amount_rwf: Math.round(cost),
      supplier_id: po.supplier_id,
      purchase_order_id: po._id,
      description: `Received ${po.number}`,
      actor: kitchen.actor,
    });
    await activity.record(kitchen, { action: 'inventory.po_received', target_type: 'purchase_order', target_id: po._id, summary: `Received ${complete ? '' : 'part of '}${po.number} (RWF ${Math.round(cost).toLocaleString('en-US')})` });
    return this.#serializePo(saved, (await this.#context(kitchen.vendorId)).suppliers);
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

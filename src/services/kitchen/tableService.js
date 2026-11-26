const crypto = require('crypto');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText, parseBooleanValue } = require('../../utils/vendorValidators');
const { DiningTable, Order, Invoice, KitchenStaff } = require('../../models');
const config = require('../../config');
const activity = require('./activityService');

const ACTIVE = ['placed', 'confirmed', 'preparing', 'ready'];

/** 128 random bits, URL-safe: unguessable, and says nothing about the kitchen or table. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const menuUrl = (token) => `${config.frontendUrl}/menu/${token}`;
const labelKey = (label) => label.trim().toLowerCase().replace(/\s+/g, ' ');

function serialize(table, extra = {}) {
  return {
    id: String(table._id),
    label: table.label,
    area: table.area || '',
    capacity: table.capacity ?? null,
    is_active: table.is_active !== false,
    token: table.token,
    menu_url: menuUrl(table.token),
    qr_svg_path: `/vendor/tables/${table._id}/qr?format=svg`,
    qr_png_path: `/vendor/tables/${table._id}/qr?format=png`,
    assigned_staff_id: table.assigned_staff_id ? String(table.assigned_staff_id) : null,
    token_rotated_at: table.token_rotated_at ?? null,
    created_at: table.created_at,
    updated_at: table.updated_at,
    ...extra,
  };
}

class TableService {
  async #load(vendorId, tableId) {
    const id = parseObjectId(tableId, 'table_id');
    const table = await DiningTable.findOne({ _id: id, vendor_id: vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    return table;
  }

  /** Tables with what is happening at each: open orders and the open bill. */
  async list(kitchen) {
    const tables = await DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    tables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const ids = tables.map((t) => t._id);
    const [orders, invoices] = await Promise.all([
      Order.aggregate([
        { $match: { vendor_id: new mongoose.Types.ObjectId(kitchen.vendorId), 'table.table_id': { $in: ids }, status: { $in: ACTIVE } } },
        { $group: { _id: '$table.table_id', n: { $sum: 1 }, ready_items: { $sum: { $size: { $filter: { input: '$items', as: 'i', cond: { $eq: ['$$i.service_status', 'waiting_collection'] } } } } } } },
      ]),
      Invoice.find({ vendor_id: kitchen.vendorId, table_id: { $in: ids }, is_open: true }).select('table_id invoice_number total_rwf amount_paid_rwf status').lean(),
    ]);
    const byTable = new Map(orders.map((o) => [String(o._id), o]));
    const bills = new Map(invoices.map((i) => [String(i.table_id), i]));
    return {
      tables: tables.map((table) => {
        const o = byTable.get(String(table._id));
        const bill = bills.get(String(table._id));
        return serialize(table, {
          active_orders: o?.n || 0,
          ready_items: o?.ready_items || 0,
          open_invoice: bill
            ? { id: String(bill._id), invoice_number: bill.invoice_number, total_rwf: bill.total_rwf, balance_due_rwf: bill.total_rwf - bill.amount_paid_rwf, status: bill.status }
            : null,
          occupied: Boolean(o?.n || bill),
        });
      }),
    };
  }

  async get(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const [orders, bill] = await Promise.all([
      Order.find({ vendor_id: kitchen.vendorId, 'table.table_id': table._id }).sort({ created_at: -1 }).limit(20).lean(),
      Invoice.findOne({ vendor_id: kitchen.vendorId, table_id: table._id, is_open: true }).lean(),
    ]);
    return serialize(table, {
      recent_orders: orders.map((o) => ({
        id: String(o._id),
        order_number: o.order_number,
        status: o.status,
        total_rwf: o.total_rwf,
        guest_name: o.guest?.name || '',
        created_at: o.created_at,
      })),
      open_invoice: bill ? { id: String(bill._id), invoice_number: bill.invoice_number, total_rwf: bill.total_rwf, balance_due_rwf: bill.total_rwf - bill.amount_paid_rwf, status: bill.status } : null,
    });
  }

  async #parse(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.label !== undefined) {
      update.label = parseRequiredText(body.label, { field: 'label', min: 1, max: 30 });
      update.label_key = labelKey(update.label);
    }
    if (body.area !== undefined) update.area = parseOptionalText(body.area, { field: 'area', max: 40 }) || '';
    if (body.capacity !== undefined) {
      if (body.capacity === null || body.capacity === '') update.capacity = null;
      else {
        const n = Number(body.capacity);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw ApiError.badRequest('Seats must be between 1 and 100.', { capacity: 'expected 1-100' });
        update.capacity = n;
      }
    }
    if (body.is_active !== undefined) update.is_active = parseBooleanValue(body.is_active, { field: 'is_active' });
    if (body.assigned_staff_id !== undefined) {
      if (!body.assigned_staff_id) update.assigned_staff_id = null;
      else {
        const staffId = parseObjectId(body.assigned_staff_id, 'assigned_staff_id');
        const ok = await KitchenStaff.exists({ _id: staffId, vendor_id: kitchen.vendorId, deleted_at: null });
        if (!ok) throw ApiError.badRequest('That employee is not part of this kitchen.', { assigned_staff_id: 'unknown employee' });
        update.assigned_staff_id = staffId;
      }
    }
    return update;
  }

  #duplicate(error, label) {
    if (error?.code === 11000) throw ApiError.conflict(`There is already a table called "${label}".`, 'TABLE_LABEL_TAKEN');
    throw error;
  }

  /** A new table gets its QR code at once (its token). */
  async create(kitchen, body = {}) {
    const update = await this.#parse(kitchen, body, { partial: false });
    const count = await DiningTable.countDocuments({ vendor_id: kitchen.vendorId, deleted_at: null });
    if (count >= 300) throw ApiError.conflict('A kitchen can have at most 300 tables.', 'TABLE_LIMIT');
    let table;
    try {
      table = await DiningTable.create({ ...update, vendor_id: kitchen.vendorId, token: newToken() });
    } catch (error) {
      this.#duplicate(error, update.label);
    }
    await activity.record(kitchen, { action: 'table.created', target_type: 'table', target_id: table._id, summary: `Added table ${table.label}` });
    return serialize(table.toObject());
  }

  /** Several tables at once: "T1" to "T12". */
  async createBatch(kitchen, body = {}) {
    const prefix = parseOptionalText(body.prefix, { field: 'prefix', max: 20 }) ?? 'Table ';
    const from = Number(body.from ?? 1);
    const to = Number(body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from >= 100) {
      throw ApiError.badRequest('Add between 1 and 100 tables at a time.', { to: 'expected from <= to, at most 100 tables' });
    }
    const created = [];
    const skipped = [];
    for (let n = from; n <= to; n += 1) {
      const label = `${prefix}${n}`.trim();
      try {
        created.push(await this.create(kitchen, { label, area: body.area, capacity: body.capacity }));
      } catch (error) {
        if (error.code === 'TABLE_LABEL_TAKEN') skipped.push(label);
        else throw error;
      }
    }
    return { created, skipped };
  }

  async update(kitchen, tableId, body = {}) {
    const table = await this.#load(kitchen.vendorId, tableId);
    if (body.assigned_staff_id !== undefined && Object.keys(body).length === 1) kitchen.assert('tables.assign');
    else kitchen.assert('tables.edit');
    const update = await this.#parse(kitchen, body, { partial: true });
    let saved;
    try {
      saved = await DiningTable.findOneAndUpdate({ _id: table._id }, { $set: update }, { returnDocument: 'after' }).lean();
    } catch (error) {
      this.#duplicate(error, update.label);
    }
    await activity.record(kitchen, {
      action: update.is_active === false ? 'table.deactivated' : 'table.updated',
      target_type: 'table',
      target_id: table._id,
      summary: `Updated table ${saved.label}`,
      details: { fields: Object.keys(update) },
    });
    return serialize(saved);
  }

  /** Replaces the QR code: the printed old one stops working at once. */
  async rotateToken(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const saved = await DiningTable.findOneAndUpdate(
      { _id: table._id },
      { $set: { token: newToken(), token_rotated_at: new Date() } },
      { returnDocument: 'after' }
    ).lean();
    await activity.record(kitchen, { action: 'table.qr_replaced', target_type: 'table', target_id: table._id, summary: `Replaced the QR code of table ${table.label}` });
    return serialize(saved);
  }

  async remove(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const busy = await Order.exists({ vendor_id: kitchen.vendorId, 'table.table_id': table._id, status: { $in: ACTIVE } });
    if (busy) throw ApiError.conflict('This table still has orders in progress.', 'TABLE_BUSY');
    // Removed tables keep their history; their QR code no longer works.
    await DiningTable.updateOne({ _id: table._id }, { $set: { deleted_at: new Date(), is_current: false, is_active: false, token: `removed-${newToken()}` } });
    await activity.record(kitchen, { action: 'table.deleted', target_type: 'table', target_id: table._id, summary: `Removed table ${table.label}` });
    return { deleted: true, id: String(table._id) };
  }

  /** The QR image for printing (SVG for print shops, PNG for phones). */
  async qr(kitchen, tableId, format = 'svg') {
    const table = await this.#load(kitchen.vendorId, tableId);
    const url = menuUrl(table.token);
    const options = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#2b1206', light: '#ffffff' } };
    if (format === 'png') return { type: 'image/png', body: await QRCode.toBuffer(url, { ...options, width: 768 }), table };
    return { type: 'image/svg+xml', body: await QRCode.toString(url, { ...options, type: 'svg' }), table };
  }

  /** The table a scanned token belongs to, or null (unknown, removed or deactivated). */
  async findByToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    return DiningTable.findOne({ token, deleted_at: null }).lean();
  }
}

module.exports = new TableService();
module.exports.serialize = serialize;
module.exports.menuUrl = menuUrl;

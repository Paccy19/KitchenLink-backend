const crypto = require('crypto');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText, parseBooleanValue } = require('../../utils/vendorValidators');
const { DiningTable, Order, Invoice, KitchenStaff, TableSession } = require('../../models');
const config = require('../../config');
const activity = require('./activityService');
const { SESSION_TTL_MS } = require('./diningSessionService');

const ACTIVE = ['placed', 'confirmed', 'preparing', 'ready'];

/** 128 random bits, URL-safe: unguessable, and says nothing about the kitchen or table. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const menuUrl = (token) => `${config.frontendUrl}/menu/${token}`;
const labelKey = (label) => label.trim().toLowerCase().replace(/\s+/g, ' ');

function seatsFor(capacity, existing = []) {
  const count = Number.isInteger(capacity) && capacity > 0 ? capacity : 0;
  const byNumber = new Map((existing || []).map((seat) => [seat.seat_number, seat]));
  return Array.from({ length: count }, (_unused, index) => {
    const seatNumber = index + 1;
    const existingSeat = byNumber.get(seatNumber);
    return {
      seat_number: seatNumber,
      token: existingSeat?.token || newToken(),
      previous_tokens: existingSeat?.previous_tokens || [],
      is_active: existingSeat?.is_active !== false,
      token_rotated_at: existingSeat?.token_rotated_at ?? null,
    };
  });
}

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
    seats: (table.seats || []).map((seat) => ({
      seat_number: seat.seat_number,
      token: seat.token,
      menu_url: menuUrl(seat.token),
      is_active: seat.is_active !== false,
      token_rotated_at: seat.token_rotated_at ?? null,
    })),
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
    let table = await DiningTable.findOne({ _id: id, vendor_id: vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.notFound('Table not found.', 'TABLE_NOT_FOUND');
    if (table.capacity && !(table.seats || []).length) {
      const seats = seatsFor(table.capacity);
      await DiningTable.updateOne({ _id: id, 'seats.0': { $exists: false } }, { $set: { seats } });
      table = await DiningTable.findById(id).lean();
    }
    return table;
  }

  /** Tables with what is happening at each: open orders and the open bill. */
  async list(kitchen) {
    const tables = await DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    tables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const ids = tables.map((t) => t._id);
    const [orders, invoices, sessions] = await Promise.all([
      Order.aggregate([
        { $match: { vendor_id: new mongoose.Types.ObjectId(kitchen.vendorId), 'table.table_id': { $in: ids }, status: { $in: ACTIVE } } },
        { $group: { _id: '$table.table_id', n: { $sum: 1 }, ready_items: { $sum: { $size: { $filter: { input: '$items', as: 'i', cond: { $eq: ['$$i.service_status', 'waiting_collection'] } } } } } } },
      ]),
      Invoice.find({ vendor_id: kitchen.vendorId, table_id: { $in: ids }, is_open: true }).select('table_id invoice_number total_rwf amount_paid_rwf status').lean(),
      TableSession.find({ vendor_id: kitchen.vendorId, table_id: { $in: ids }, status: 'active' }).select('table_id customer_sessions').lean(),
    ]);
    const tableRows = await Promise.all(tables.map(async (table) => {
      if (table.capacity && !(table.seats || []).length) {
        await DiningTable.updateOne({ _id: table._id, 'seats.0': { $exists: false } }, { $set: { seats: seatsFor(table.capacity) } });
        return DiningTable.findById(table._id).lean();
      }
      return table;
    }));
    const byTable = new Map(orders.map((o) => [String(o._id), o]));
    const bills = new Map(invoices.map((i) => [String(i.table_id), i]));
    const sessionsByTable = new Map(sessions.map((s) => [String(s.table_id), s]));
    return {
      tables: tableRows.map((table) => {
        const o = byTable.get(String(table._id));
        const bill = bills.get(String(table._id));
        const tableSession = sessionsByTable.get(String(table._id));
        const activeSeats = (tableSession?.customer_sessions || []).filter((s) => s.status === 'active' && s.expires_at > new Date()).length;
        return serialize(table, {
          active_table_session_id: tableSession ? String(tableSession._id) : null,
          active_orders: o?.n || 0,
          ready_items: o?.ready_items || 0,
          active_customer_sessions: activeSeats,
          open_invoice: bill
            ? { id: String(bill._id), invoice_number: bill.invoice_number, total_rwf: bill.total_rwf, balance_due_rwf: bill.total_rwf - bill.amount_paid_rwf, status: bill.status }
            : null,
          occupied: Boolean(o?.n || bill || activeSeats),
        });
      }),
    };
  }

  async get(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const [orders, bill, tableSession] = await Promise.all([
      Order.find({ vendor_id: kitchen.vendorId, 'table.table_id': table._id }).sort({ created_at: -1 }).limit(20).lean(),
      Invoice.findOne({ vendor_id: kitchen.vendorId, table_id: table._id, is_open: true }).lean(),
      TableSession.findOne({ vendor_id: kitchen.vendorId, table_id: table._id, status: 'active' }).select('customer_sessions').lean(),
    ]);
    return serialize(table, {
      active_table_session_id: tableSession ? String(tableSession._id) : null,
      active_customer_sessions: (tableSession?.customer_sessions || []).filter((s) => s.status === 'active' && s.expires_at > new Date()).map((s) => ({
        seat_number: s.seat_number,
        guest_name: s.guest_name || '',
        started_at: s.started_at,
      })),
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

  async closeDiningSession(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const tableSession = await TableSession.findOne({
      vendor_id: kitchen.vendorId,
      table_id: table._id,
      status: 'active',
    }).lean();
    if (!tableSession) return { table_id: String(table._id), status: 'closed', already_closed: true };

    const [activeOrder, unpaidOrder] = await Promise.all([
      Order.exists({
        table_session_id: tableSession._id,
        status: { $nin: ['completed', 'cancelled'] },
      }),
      Order.exists({
        table_session_id: tableSession._id,
        payment_status: { $ne: 'paid' },
        status: { $ne: 'cancelled' },
      }),
    ]);
    if (activeOrder) {
      throw ApiError.conflict('Finish preparing and serving this table session before closing it.', 'TABLE_SESSION_HAS_ACTIVE_ORDERS');
    }
    if (unpaidOrder) {
      throw ApiError.conflict('Settle all outstanding orders before closing this table session.', 'TABLE_SESSION_HAS_UNPAID_ORDERS');
    }

    const closedAt = new Date();
    const closed = await TableSession.findOneAndUpdate(
      { _id: tableSession._id, vendor_id: kitchen.vendorId, status: 'active' },
      {
        $set: {
          status: 'closed',
          closed_at: closedAt,
          'customer_sessions.$[customer].status': 'closed',
          'customer_sessions.$[customer].closed_at': closedAt,
          'payment_authorizations.$[grant].status': 'expired',
          'payment_authorizations.$[grant].token_hash': null,
        },
      },
      {
        arrayFilters: [
          { 'customer.status': 'active' },
          { 'grant.status': { $in: ['pending', 'authorized'] } },
        ],
        returnDocument: 'after',
      }
    ).lean();
    if (!closed) return { table_id: String(table._id), status: 'closed', already_closed: true };

    await activity.record(kitchen, {
      action: 'table_session.closed',
      target_type: 'table_session',
      target_id: tableSession._id,
      summary: `Closed the dining session for ${table.label}`,
    });
    return {
      table_id: String(table._id),
      table_session_id: String(closed._id),
      status: closed.status,
      closed_at: closed.closed_at,
      already_closed: false,
    };
  }

  async releaseSeat(kitchen, tableId, rawSeatNumber, body = {}) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const seatNumber = Number(rawSeatNumber);
    if (!Number.isInteger(seatNumber) || seatNumber < 1) {
      throw ApiError.badRequest('Choose a valid seat number.', { seat_number: 'expected a positive integer' });
    }
    const tableSession = await TableSession.findOne({
      vendor_id: kitchen.vendorId,
      table_id: table._id,
      status: 'active',
    }).lean();
    const customerSession = (tableSession?.customer_sessions || []).find(
      (entry) => entry.seat_number === seatNumber && entry.status === 'active' && entry.expires_at > new Date()
    );
    if (!tableSession || !customerSession) {
      throw ApiError.notFound('There is no active customer session in that seat.', 'SEAT_SESSION_NOT_FOUND');
    }
    const [orders, lockedOrder] = await Promise.all([
      Order.find({
        table_session_id: tableSession._id,
        customer_session_id: customerSession._id,
        status: { $ne: 'cancelled' },
      }).select('payment_status status').lean(),
      Order.exists({
        table_session_id: tableSession._id,
        customer_session_id: customerSession._id,
        payment_lock_id: { $ne: null },
      }),
    ]);
    if (lockedOrder) throw ApiError.conflict('A payment is being processed for this seat.', 'SEAT_PAYMENT_PENDING');
    const hasActiveOrder = orders.some((order) => !['completed', 'cancelled'].includes(order.status));
    if (hasActiveOrder) {
      throw ApiError.conflict("Finish preparing and serving this seat's orders before releasing it.", 'SEAT_HAS_ACTIVE_ORDERS');
    }
    const hasUnpaidOrder = orders.some((order) => order.payment_status !== 'paid');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    if (hasUnpaidOrder && (!reason || !kitchen.can('invoices.edit'))) {
      throw ApiError.conflict(
        'This seat still has an unpaid balance. Settle it first or provide a reason with invoice-edit permission for an exceptional release.',
        'SEAT_HAS_UNPAID_ORDERS'
      );
    }
    const closedAt = new Date();
    const closed = await TableSession.findOneAndUpdate(
      {
        _id: tableSession._id,
        status: 'active',
        customer_sessions: {
          $elemMatch: { _id: customerSession._id, status: 'active', expires_at: { $gt: closedAt } },
        },
      },
      {
        $set: {
          'customer_sessions.$.status': 'closed',
          'customer_sessions.$.closed_at': closedAt,
          'payment_authorizations.$[grant].status': 'expired',
          'payment_authorizations.$[grant].token_hash': null,
        },
      },
      {
        arrayFilters: [
          { 'grant.status': { $in: ['pending', 'authorized'] }, 'grant.beneficiary_customer_session_id': customerSession._id },
        ],
        returnDocument: 'after',
      }
    ).lean();
    if (!closed) throw ApiError.conflict('This seat changed while it was being released. Refresh and try again.', 'SEAT_SESSION_CHANGED');
    await activity.record(kitchen, {
      action: 'table.seat_released',
      target_type: 'table_session',
      target_id: tableSession._id,
      summary: `Released seat ${seatNumber} at ${table.label}`,
      details: { seat_number: seatNumber, exceptional: hasUnpaidOrder, reason: hasUnpaidOrder ? reason : '' },
    });
    return {
      table_id: String(table._id),
      table_session_id: String(tableSession._id),
      customer_session_id: String(customerSession._id),
      seat_number: seatNumber,
      status: 'released',
      exceptional: hasUnpaidOrder,
    };
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
      table = await DiningTable.create({
        ...update,
        seats: seatsFor(update.capacity),
        vendor_id: kitchen.vendorId,
        token: newToken(),
      });
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
    const update = await this.#parse(kitchen, body, { partial: true });
    const anyOf = (permissions) => {
      if (!permissions.some((permission) => kitchen.can(permission))) kitchen.assert(permissions[0]);
    };
    const changed = (field) => update[field] !== undefined && String(update[field] ?? '') !== String(table[field] ?? '');
    if (['label', 'area', 'capacity'].some(changed)) anyOf(['tables.edit']);
    if (changed('is_active')) anyOf(['tables.activate', 'reservations.table_availability']);
    if (changed('assigned_staff_id')) anyOf(['service.assign_servers', 'service.transfer_servers']);
    if (update.capacity !== undefined) {
      const seatCount = update.capacity || 0;
      const occupiedSeat = await TableSession.exists({
        vendor_id: kitchen.vendorId,
        table_id: table._id,
        status: 'active',
        customer_sessions: { $elemMatch: { seat_number: { $gt: seatCount }, status: 'active' } },
      });
      if (occupiedSeat) {
        throw ApiError.conflict('Move or close the customer sessions in those seats before reducing table capacity.', 'TABLE_SEATS_OCCUPIED');
      }
      update.seats = seatsFor(update.capacity, table.seats);
    }
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

  async rotateSeatToken(kitchen, tableId, rawSeatNumber) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const seatNumber = Number(rawSeatNumber);
    if (!Number.isInteger(seatNumber) || seatNumber < 1) {
      throw ApiError.badRequest('Choose a valid seat number.', { seat_number: 'expected a positive integer' });
    }
    const seat = (table.seats || []).find((entry) => entry.seat_number === seatNumber);
    if (!seat || seat.is_active === false) throw ApiError.notFound('Seat not found.', 'SEAT_NOT_FOUND');
    const now = new Date();
    const token = newToken();
    const saved = await DiningTable.findOneAndUpdate(
      { _id: table._id, 'seats.seat_number': seatNumber, 'seats.token': seat.token },
      {
        $set: {
          'seats.$.token': token,
          'seats.$.token_rotated_at': now,
          'seats.$.previous_tokens': [
            ...(seat.previous_tokens || []).filter((entry) => entry.valid_until > now),
            { token: seat.token, valid_until: new Date(now.getTime() + SESSION_TTL_MS) },
          ],
        },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This seat QR code just changed. Refresh and try again.', 'SEAT_QR_CHANGED');
    await activity.record(kitchen, {
      action: 'table.seat_qr_replaced',
      target_type: 'table',
      target_id: table._id,
      summary: `Replaced the QR code for seat ${seatNumber} at ${table.label}`,
      details: { seat_number: seatNumber },
    });
    return serialize(saved);
  }

  async remove(kitchen, tableId) {
    const table = await this.#load(kitchen.vendorId, tableId);
    const [busyOrder, openBill, liveSession] = await Promise.all([
      Order.exists({ vendor_id: kitchen.vendorId, 'table.table_id': table._id, status: { $in: ACTIVE } }),
      Invoice.exists({ vendor_id: kitchen.vendorId, table_id: table._id, is_open: true }),
      TableSession.exists({
        vendor_id: kitchen.vendorId,
        table_id: table._id,
        status: 'active',
        customer_sessions: { $elemMatch: { status: 'active', expires_at: { $gt: new Date() } } },
      }),
    ]);
    const busy = busyOrder || openBill || liveSession;
    if (busy) throw ApiError.conflict('This table still has orders in progress.', 'TABLE_BUSY');
    // Removed tables keep their history; their QR code no longer works.
    await DiningTable.updateOne({ _id: table._id }, { $set: { deleted_at: new Date(), is_current: false, is_active: false, token: `removed-${newToken()}` } });
    await activity.record(kitchen, { action: 'table.deleted', target_type: 'table', target_id: table._id, summary: `Removed table ${table.label}` });
    return { deleted: true, id: String(table._id) };
  }

  /** The QR image for printing (SVG for print shops, PNG for phones). */
  async qr(kitchen, tableId, format = 'svg', rawSeatNumber = null) {
    const table = await this.#load(kitchen.vendorId, tableId);
    let token = table.token;
    let seat = null;
    if (rawSeatNumber !== null && rawSeatNumber !== undefined && rawSeatNumber !== '') {
      const seatNumber = Number(rawSeatNumber);
      if (!Number.isInteger(seatNumber) || seatNumber < 1) {
        throw ApiError.badRequest('Choose a valid seat number.', { seat_number: 'expected a positive integer' });
      }
      seat = (table.seats || []).find((entry) => entry.seat_number === seatNumber && entry.is_active !== false);
      if (!seat) throw ApiError.notFound('Seat not found.', 'SEAT_NOT_FOUND');
      token = seat.token;
    }
    const url = menuUrl(token);
    const options = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#2b1206', light: '#ffffff' } };
    if (format === 'png') return { type: 'image/png', body: await QRCode.toBuffer(url, { ...options, width: 768 }), table, seat };
    return { type: 'image/svg+xml', body: await QRCode.toString(url, { ...options, type: 'svg' }), table, seat };
  }

  /** The table and optional seat a scanned token belongs to. */
  async findByToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    let table = await DiningTable.findOne({
      $or: [{ token }, { 'seats.token': token }, { 'seats.previous_tokens.token': token }],
      deleted_at: null,
    }).lean();
    if (!table) return null;
    if (table.capacity && !(table.seats || []).length) {
      const seats = seatsFor(table.capacity);
      await DiningTable.updateOne({ _id: table._id, 'seats.0': { $exists: false } }, { $set: { seats } });
      table = await DiningTable.findById(table._id).lean();
    }
    const now = new Date();
    const seat = (table.seats || []).find((entry) =>
      entry.is_active !== false &&
      (entry.token === token || (entry.previous_tokens || []).some((old) => old.token === token && old.valid_until > now))
    );
    if (seat) return { ...table, _qr_seat_number: seat.seat_number, _qr_seat_token_current: seat.token === token };
    if (table.token !== token) return null;
    return table;
  }
}

module.exports = new TableService();
module.exports.serialize = serialize;
module.exports.menuUrl = menuUrl;

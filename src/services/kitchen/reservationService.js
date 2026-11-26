const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { Reservation, DiningTable, Invoice, Order } = require('../../models');
const alerts = require('./alertService');
const activity = require('./activityService');

const ACTIVE = ['booked', 'seated'];

const serialize = (r) => ({
  id: String(r._id),
  name: r.name,
  phone: r.phone || '',
  party_size: r.party_size,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  duration_minutes: r.duration_minutes,
  table: r.table_id ? { id: String(r.table_id), label: r.table_label } : null,
  status: r.status,
  notes: r.notes || '',
  created_by: r.created_by?.name || '',
  seated_at: r.seated_at,
  created_at: r.created_at,
});

const parseWhen = (raw) => {
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) throw ApiError.badRequest('Pick the date and time.', { starts_at: 'expected a date and time' });
  return d;
};

class ReservationService {
  async list(kitchen, query = {}) {
    kitchen.assert('reservations.view');
    const from = query.from ? parseWhen(query.from) : new Date(Date.now() - 6 * 3600000);
    const to = query.to ? parseWhen(query.to) : new Date(from.getTime() + 14 * 86400000);
    const filter = { vendor_id: kitchen.vendorId, starts_at: { $gte: from, $lte: to } };
    if (['booked', 'seated', 'completed', 'cancelled', 'no_show'].includes(query.status)) filter.status = query.status;
    const rows = await Reservation.find(filter).sort({ starts_at: 1 }).limit(300).lean();
    return { reservations: rows.map(serialize) };
  }

  /** A table is taken if another active booking overlaps the time. */
  async #assertTableFree(kitchen, tableId, startsAt, endsAt, exceptId = null) {
    const clash = await Reservation.findOne({
      vendor_id: kitchen.vendorId,
      table_id: tableId,
      status: { $in: ACTIVE },
      starts_at: { $lt: endsAt },
      ends_at: { $gt: startsAt },
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    }).lean();
    if (clash) throw ApiError.conflict(`That table is booked for ${clash.name} at that time.`, 'TABLE_BOOKED');
  }

  async #table(kitchen, raw) {
    if (!raw) return null;
    const table = await DiningTable.findOne({ _id: parseObjectId(raw, 'table_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.badRequest('That table is not in your kitchen.', { table_id: 'unknown table' });
    if (!table.is_active) throw ApiError.conflict('That table is switched off.', 'TABLE_INACTIVE');
    return table;
  }

  async create(kitchen, body = {}) {
    kitchen.assert('reservations.create');
    const startsAt = parseWhen(body.starts_at);
    const duration = Number(body.duration_minutes ?? 90);
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw ApiError.badRequest('Duration is 15 minutes to 12 hours.', { duration_minutes: 'expected 15-720' });
    const party = Number(body.party_size);
    if (!Number.isInteger(party) || party < 1 || party > 200) throw ApiError.badRequest('How many guests?', { party_size: 'expected 1-200' });
    const endsAt = new Date(startsAt.getTime() + duration * 60000);
    let table = null;
    if (body.table_id) {
      kitchen.assert('reservations.assign_tables');
      table = await this.#table(kitchen, body.table_id);
      await this.#assertTableFree(kitchen, table._id, startsAt, endsAt);
    }
    const r = await Reservation.create({
      vendor_id: kitchen.vendorId,
      name: parseRequiredText(body.name, { field: 'name', min: 2, max: 80 }),
      phone: parseOptionalText(body.phone, { field: 'phone', max: 20 }) || '',
      party_size: party,
      starts_at: startsAt,
      duration_minutes: duration,
      ends_at: endsAt,
      table_id: table?._id || null,
      table_label: table?.label || '',
      notes: parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '',
      created_by: kitchen.actor,
    });
    alerts.emit(kitchen.vendorId, 'reservations', { title: `New booking: ${r.name} (${party})`, body: startsAt.toLocaleString('en-GB', { timeZone: 'Africa/Kigali' }), link: '/vendor-dashboard/reservations', permission: 'reservations.view' });
    await activity.record(kitchen, { action: 'reservation.created', target_type: 'reservation', target_id: r._id, summary: `Booked ${r.name} for ${party}` });
    return serialize(r.toObject());
  }

  async update(kitchen, reservationId, body = {}) {
    const r = await Reservation.findOne({ _id: parseObjectId(reservationId, 'reservation_id'), vendor_id: kitchen.vendorId }).lean();
    if (!r) throw ApiError.notFound('Reservation not found.', 'RESERVATION_NOT_FOUND');
    const set = {};
    const status = body.status;
    if (status !== undefined) {
      const allowed = { cancelled: ['reservations.cancel'], seated: ['reservations.edit', 'reservations.manage_sessions'], completed: ['reservations.edit', 'reservations.extend_close'], no_show: ['reservations.edit', 'reservations.cancel'], booked: ['reservations.edit'] }[status];
      if (!allowed) throw ApiError.badRequest('Unknown status.', { status: 'expected booked, seated, completed, cancelled or no_show' });
      if (!allowed.some((p) => kitchen.can(p))) kitchen.assert(allowed[0]);
      set.status = status;
      if (status === 'seated') set.seated_at = new Date();
      if (status === 'cancelled') set.cancelled_at = new Date();
    }
    const changesBooking = ['name', 'phone', 'party_size', 'starts_at', 'notes'].some((f) => body[f] !== undefined);
    if (changesBooking) {
      kitchen.assert('reservations.edit');
      if (body.name !== undefined) set.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 80 });
      if (body.phone !== undefined) set.phone = parseOptionalText(body.phone, { field: 'phone', max: 20 }) || '';
      if (body.notes !== undefined) set.notes = parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '';
      if (body.party_size !== undefined) {
        const party = Number(body.party_size);
        if (!Number.isInteger(party) || party < 1 || party > 200) throw ApiError.badRequest('How many guests?', { party_size: 'expected 1-200' });
        set.party_size = party;
      }
      if (body.starts_at !== undefined) set.starts_at = parseWhen(body.starts_at);
    }
    // "Extend or close sessions": a longer stay.
    if (body.duration_minutes !== undefined) {
      if (!['reservations.extend_close', 'reservations.edit'].some((p) => kitchen.can(p))) kitchen.assert('reservations.extend_close');
      const duration = Number(body.duration_minutes);
      if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw ApiError.badRequest('Duration is 15 minutes to 12 hours.', { duration_minutes: 'expected 15-720' });
      set.duration_minutes = duration;
    }
    const startsAt = set.starts_at || r.starts_at;
    const duration = set.duration_minutes || r.duration_minutes;
    set.ends_at = new Date(new Date(startsAt).getTime() + duration * 60000);
    if (body.table_id !== undefined) {
      kitchen.assert('reservations.assign_tables');
      const table = await this.#table(kitchen, body.table_id);
      set.table_id = table?._id || null;
      set.table_label = table?.label || '';
    }
    const tableId = set.table_id !== undefined ? set.table_id : r.table_id;
    if (tableId && ACTIVE.includes(set.status || r.status)) await this.#assertTableFree(kitchen, tableId, startsAt, set.ends_at, r._id);
    const saved = await Reservation.findOneAndUpdate({ _id: r._id }, { $set: set }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, { action: 'reservation.updated', target_type: 'reservation', target_id: r._id, summary: `Booking of ${saved.name}: ${Object.keys(set).filter((k) => k !== 'ends_at').join(', ')}` });
    return serialize(saved);
  }

  /** "Manage table availability": which tables are free for a party at a time. */
  async availability(kitchen, query = {}) {
    if (!['reservations.table_availability', 'reservations.assign_tables', 'reservations.view'].some((p) => kitchen.can(p))) kitchen.assert('reservations.table_availability');
    const startsAt = query.at ? parseWhen(query.at) : new Date();
    const duration = Number(query.duration_minutes || 90);
    const endsAt = new Date(startsAt.getTime() + duration * 60000);
    const party = Number(query.party_size || 1);
    const [tables, bookings] = await Promise.all([
      DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean(),
      Reservation.find({ vendor_id: kitchen.vendorId, status: { $in: ACTIVE }, table_id: { $ne: null }, starts_at: { $lt: endsAt }, ends_at: { $gt: startsAt } }).lean(),
    ]);
    const busy = new Map(bookings.map((b) => [String(b.table_id), b]));
    return {
      at: startsAt,
      tables: tables
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        .map((t) => ({
          id: String(t._id),
          label: t.label,
          capacity: t.capacity ?? null,
          is_active: t.is_active !== false,
          fits: !t.capacity || t.capacity >= party,
          booked_by: busy.get(String(t._id))?.name || null,
          free: t.is_active !== false && !busy.has(String(t._id)) && (!t.capacity || t.capacity >= party),
        })),
    };
  }

  /** "View active dining sessions": tables with an open bill or seated guests right now. */
  async sessions(kitchen) {
    if (!['reservations.active_sessions', 'tables.sessions_view', 'reservations.manage_sessions'].some((p) => kitchen.can(p))) kitchen.assert('reservations.active_sessions');
    const [bills, seated, open] = await Promise.all([
      Invoice.find({ vendor_id: kitchen.vendorId, kind: 'table', is_open: true }).lean(),
      Reservation.find({ vendor_id: kitchen.vendorId, status: 'seated' }).lean(),
      Order.aggregate([
        { $match: { vendor_id: require('mongoose').Types.ObjectId.createFromHexString(kitchen.vendorId), 'table.table_id': { $ne: null }, status: { $nin: ['delivered', 'cancelled'] } } },
        { $group: { _id: '$table.table_id', orders: { $sum: 1 }, since: { $min: '$created_at' } } },
      ]),
    ]);
    const tables = await DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    const byTable = new Map(tables.map((t) => [String(t._id), { table: { id: String(t._id), label: t.label }, bill: null, reservation: null, open_orders: 0, since: null }]));
    for (const b of bills) {
      const row = byTable.get(String(b.table_id));
      if (row) Object.assign(row, { bill: { id: String(b._id), invoice_number: b.invoice_number, total_rwf: b.total_rwf, balance_due_rwf: b.total_rwf - b.amount_paid_rwf }, since: row.since || b.created_at });
    }
    for (const r of seated) {
      const row = r.table_id && byTable.get(String(r.table_id));
      if (row) Object.assign(row, { reservation: serialize(r), since: row.since || r.seated_at });
    }
    for (const o of open) {
      const row = byTable.get(String(o._id));
      if (row) Object.assign(row, { open_orders: o.orders, since: row.since && row.since < o.since ? row.since : o.since });
    }
    return { sessions: [...byTable.values()].filter((r) => r.bill || r.reservation || r.open_orders) };
  }
}

module.exports = new ReservationService();

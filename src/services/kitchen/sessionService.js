const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { DiningTable, Invoice, KitchenStaff, Order, PackingTask, Reservation, ServiceRequest, TableSession, Vendor, WaitlistEntry } = require('../../models');
const alerts = require('./alertService');
const activity = require('./activityService');

/**
 * Table visits (TableSession): the host seats guests (walk-ins, the waiting
 * list or a reservation), a server looks after them, every order placed at
 * the table joins the visit and its one bill, and the visit is closed by the
 * kitchen's rules (or a manager's override, recorded with a reason).
 */
const LIVE = ['open', 'active', 'awaiting_payment', 'closing'];
const DONE = ['delivered', 'cancelled'];
const SOON_MINUTES = 60;
const CLOSE_RULES = { orders_complete: true, paid: true, packing_resolved: true, requests_resolved: false };

const anyOf = (kitchen, perms) => {
  if (!perms.some((p) => kitchen.can(p))) kitchen.assert(perms[0]);
};
const guestCount = (raw, { required = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw ApiError.badRequest('How many guests?', { guest_count: 'required' });
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw ApiError.badRequest('How many guests? (1 to 200)', { guest_count: 'expected 1-200' });
  return n;
};
const isDuplicate = (error) => error?.code === 11000;

class SessionService {
  // --- used by ordering -------------------------------------------------

  /** The table's live visit, opened now if there is none (first QR scan, staff order). */
  async liveForTable(table, { source = 'qr', actor = { type: 'system', name: 'Table order' } } = {}) {
    const found = await TableSession.findOne({ vendor_id: table.vendor_id, table_id: table._id, status: 'active' }).lean();
    if (found) return found;
    try {
      return (
        await TableSession.create({ vendor_id: table.vendor_id, table_id: table._id, table_label: table.label, source, started_by: actor, server_id: table.assigned_staff_id || null, server_name: table.assigned_staff_id ? await this.#staffName(table.assigned_staff_id) : '' })
      ).toObject();
    } catch (error) {
      // Two first orders at the same moment: both join the one that won.
      if (!isDuplicate(error)) throw error;
      return TableSession.findOne({ vendor_id: table.vendor_id, table_id: table._id, status: 'active' }).lean();
    }
  }

  async attachOrder(session, order) {
    await TableSession.updateOne(
      { _id: session._id },
      { $addToSet: { order_ids: order._id } }
    );
  }

  async #staffName(staffId) {
    const s = await KitchenStaff.findById(staffId).select('name').lean();
    return s?.name || '';
  }

  // --- reading ------------------------------------------------------------

  async #summaries(sessions) {
    if (!sessions.length) return new Map();
    const ids = sessions.map((s) => s._id);
    const [orders, bills, packing, requests] = await Promise.all([
      Order.find({ table_session_id: { $in: ids } }).select('table_session_id status items.service_status items.takeaway order_number total_rwf created_at tickets.flags').lean(),
      Invoice.find({ session_id: { $in: ids }, status: { $ne: 'void' } }).select('session_id invoice_number total_rwf amount_paid_rwf refunded_rwf status is_open').lean(),
      PackingTask.find({ session_id: { $in: ids }, status: { $in: ['requested', 'packed'] } }).select('session_id').lean(),
      ServiceRequest.find({ table_id: { $in: sessions.map((s) => s.table_id) }, status: { $in: ['open', 'acknowledged'] } }).select('table_id kind').lean(),
    ]);
    const out = new Map(ids.map((id) => [String(id), { orders: [], bills: [], packing: 0, requests: 0 }]));
    for (const o of orders) out.get(String(o.table_session_id))?.orders.push(o);
    for (const b of bills) out.get(String(b.session_id))?.bills.push(b);
    for (const p of packing) out.get(String(p.session_id)).packing += 1;
    const byTable = new Map();
    for (const r of requests) byTable.set(String(r.table_id), (byTable.get(String(r.table_id)) || 0) + 1);
    for (const s of sessions) out.get(String(s._id)).requests = s.status === 'active' ? byTable.get(String(s.table_id)) || 0 : 0;
    return out;
  }

  /** What still stops the visit from closing, under the kitchen's rules. */
  #blockers(summary, rules) {
    const open = summary.orders.filter((o) => !DONE.includes(o.status));
    const balance = summary.bills.reduce((sum, b) => sum + (['unpaid', 'partially_paid'].includes(b.status) ? b.total_rwf - b.amount_paid_rwf : 0), 0);
    const all = [];
    if (rules.orders_complete && open.length) all.push({ code: 'orders_open', message: `${open.length} order${open.length === 1 ? ' is' : 's are'} not finished.` });
    if (rules.paid && balance > 0) all.push({ code: 'unpaid', message: `RWF ${balance.toLocaleString('en-US')} is still due on the bill.` });
    if (rules.packing_resolved && summary.packing) all.push({ code: 'packing_open', message: `${summary.packing} packing request${summary.packing === 1 ? ' is' : 's are'} not handed over.` });
    if (rules.requests_resolved && summary.requests) all.push({ code: 'requests_open', message: 'The guests have an open request (waiter or bill).' });
    return { blockers: all, balance_due_rwf: balance, open_orders: open.length };
  }

  #state(session, summary, rules) {
    const check = this.#blockers(summary, rules);
    let status = session.status;
    if (session.status === 'active') {
      if (!summary.orders.length) status = 'open';
      else if (check.open_orders) status = 'active';
      else status = check.balance_due_rwf > 0 ? 'awaiting_payment' : 'active';
    }
    return { status, ...check };
  }

  #serialize(session, summary, rules, { detail = false } = {}) {
    const state = this.#state(session, summary, rules);
    const ready = summary.orders.reduce((n, o) => n + o.items.filter((i) => i.service_status === 'waiting_collection').length, 0);
    const flags = summary.orders.reduce((n, o) => n + (o.tickets || []).reduce((m, t) => m + (t.flags || []).filter((f) => !f.resolved_at).length, 0), 0);
    const bill = summary.bills.find((b) => b.is_open) || summary.bills[0] || null;
    const out = {
      id: String(session._id),
      table: { id: String(session.table_id), label: session.table_label },
      status: state.status,
      guest_count: session.guest_count,
      customer_name: session.customer_name || '',
      customer_phone: session.customer_phone || '',
      server: session.server_id ? { id: String(session.server_id), name: session.server_name } : null,
      source: session.source,
      reservation_id: session.reservation_id ? String(session.reservation_id) : null,
      orders_count: summary.orders.length,
      open_orders: state.open_orders,
      ready_items: ready,
      open_flags: flags,
      packing_open: summary.packing,
      open_requests: summary.requests,
      total_rwf: summary.bills.reduce((sum, b) => sum + b.total_rwf, 0),
      balance_due_rwf: state.balance_due_rwf,
      invoice: bill ? { id: String(bill._id), invoice_number: bill.invoice_number, status: bill.status } : null,
      can_close: !state.blockers.length,
      blockers: state.blockers,
      notes: session.notes || '',
      started_at: session.started_at,
      closed_at: session.closed_at,
      minutes: Math.round(((session.closed_at ? new Date(session.closed_at) : new Date()) - new Date(session.started_at)) / 60000),
    };
    if (detail) {
      out.orders = summary.orders.map((o) => ({ id: String(o._id), order_number: o.order_number, status: o.status, total_rwf: o.total_rwf, created_at: o.created_at }));
      out.transfers = session.transfers || [];
      out.close_exceptions = session.close_exceptions || [];
      out.closed_by = session.closed_by?.name || '';
      out.started_by = session.started_by?.name || '';
    }
    return out;
  }

  async #rules(vendorId) {
    const v = await Vendor.findById(vendorId).select('operations.session_close').lean();
    return { ...CLOSE_RULES, ...(v?.operations?.session_close || {}) };
  }

  async #load(kitchen, sessionId) {
    const s = await TableSession.findOne({ _id: parseObjectId(sessionId, 'session_id'), vendor_id: kitchen.vendorId }).lean();
    if (!s) throw ApiError.notFound('That table visit was not found.', 'SESSION_NOT_FOUND');
    return s;
  }

  /** Servers who only see their own tables. */
  #onlyMine(kitchen) {
    return !['tables.view', 'tables.sessions_view', 'tables.seat', 'reservations.active_sessions', 'reservations.manage_sessions'].some((p) => kitchen.can(p)) && kitchen.can('service.view_assigned');
  }

  #assertMine(kitchen, session) {
    if (this.#onlyMine(kitchen) && String(session.server_id) !== String(kitchen.actor.id)) {
      throw ApiError.forbidden('This table is looked after by someone else.', 'NOT_YOUR_TABLE');
    }
  }

  async get(kitchen, sessionId, { checked = false } = {}) {
    // After an action the person was allowed to take, they see its result.
    if (!checked) anyOf(kitchen, ['tables.sessions_view', 'tables.view', 'tables.seat', 'service.view_assigned', 'reservations.active_sessions', 'reservations.manage_sessions']);
    const session = await this.#load(kitchen, sessionId);
    if (!checked) this.#assertMine(kitchen, session);
    const [summaries, rules] = await Promise.all([this.#summaries([session]), this.#rules(kitchen.vendorId)]);
    return this.#serialize(session, summaries.get(String(session._id)), rules, { detail: true });
  }

  /** Visits: live ones by default, or closed ones of a day (history). */
  async list(kitchen, query = {}) {
    anyOf(kitchen, ['tables.sessions_view', 'tables.view', 'tables.seat', 'service.view_assigned', 'reservations.active_sessions', 'reservations.manage_sessions']);
    const filter = { vendor_id: kitchen.vendorId };
    if (query.status === 'closed') {
      filter.status = 'closed';
      const since = query.from ? new Date(query.from) : new Date(Date.now() - 86400000);
      if (Number.isNaN(since.getTime())) throw ApiError.badRequest('Pick a valid date.', { from: 'expected a date' });
      filter.closed_at = { $gte: since };
    } else filter.status = 'active';
    if (this.#onlyMine(kitchen) || query.mine === 'true') filter.server_id = kitchen.actor.type === 'staff' ? kitchen.actor.id : null;
    const sessions = await TableSession.find(filter).sort({ started_at: -1 }).limit(200).lean();
    const [summaries, rules] = await Promise.all([this.#summaries(sessions), this.#rules(kitchen.vendorId)]);
    return { sessions: sessions.map((s) => this.#serialize(s, summaries.get(String(s._id)), rules)) };
  }

  /**
   * The host's floor: every table with its state (available, occupied,
   * reserved soon, unavailable), the waiting list and today's arrivals.
   */
  async board(kitchen) {
    anyOf(kitchen, ['tables.seat', 'tables.view', 'tables.sessions_view', 'tables.waitlist', 'reservations.check_in', 'service.view_assigned']);
    const now = new Date();
    const soon = new Date(now.getTime() + SOON_MINUTES * 60000);
    const dayStart = new Date(now.getTime() - 6 * 3600000);
    const dayEnd = new Date(now.getTime() + 18 * 3600000);
    const [tables, sessions, upcoming, waitlist, staff, rules] = await Promise.all([
      DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean(),
      TableSession.find({ vendor_id: kitchen.vendorId, status: 'active' }).lean(),
      Reservation.find({ vendor_id: kitchen.vendorId, status: { $in: ['pending', 'confirmed', 'booked', 'arrived'] }, starts_at: { $gte: dayStart, $lte: dayEnd } }).sort({ starts_at: 1 }).lean(),
      kitchen.can('tables.waitlist') || kitchen.can('tables.seat') ? WaitlistEntry.find({ vendor_id: kitchen.vendorId, status: 'waiting' }).sort({ created_at: 1 }).lean() : [],
      KitchenStaff.find({ vendor_id: kitchen.vendorId, is_current: true, deleted_at: null, is_active: { $ne: false } }).select('name').lean(),
      this.#rules(kitchen.vendorId),
    ]);
    const summaries = await this.#summaries(sessions);
    const bySession = new Map(sessions.map((s) => [String(s.table_id), s]));
    const mine = this.#onlyMine(kitchen);
    tables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const rows = tables
      .map((t) => {
        const session = bySession.get(String(t._id));
        const next = upcoming.find((r) => r.table_id && String(r.table_id) === String(t._id) && new Date(r.starts_at) <= soon && !['arrived'].includes(r.status));
        let state = 'available';
        if (!t.is_active) state = 'unavailable';
        else if (session) state = 'occupied';
        else if (next) state = 'reserved';
        return {
          id: String(t._id),
          label: t.label,
          area: t.area || '',
          capacity: t.capacity ?? null,
          state,
          session: session ? this.#serialize(session, summaries.get(String(session._id)), rules) : null,
          next_reservation: next ? { id: String(next._id), name: next.name, party_size: next.party_size, starts_at: next.starts_at, status: next.status } : null,
        };
      })
      .filter((row) => !mine || (row.session && row.session.server?.id === String(kitchen.actor.id)));
    const counts = rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] || 0) + 1 }), { available: 0, occupied: 0, reserved: 0, unavailable: 0 });
    return {
      tables: rows,
      counts,
      waitlist: waitlist.map((w) => this.#waitView(w)),
      arrivals: kitchen.can('reservations.view') || kitchen.can('reservations.check_in') || kitchen.can('tables.seat')
        ? upcoming.map((r) => ({ id: String(r._id), name: r.name, phone: r.phone || '', party_size: r.party_size, starts_at: r.starts_at, status: r.status === 'booked' ? 'confirmed' : r.status, table: r.table_id ? { id: String(r.table_id), label: r.table_label } : null, deposit_status: r.deposit?.status || 'none', has_preorder: Boolean(r.preorder_items?.length), special_requests: r.special_requests || '' }))
        : [],
      servers: staff.map((s) => ({ id: String(s._id), name: s.name })),
    };
  }

  // --- seating -----------------------------------------------------------

  async #table(kitchen, raw, field = 'table_id') {
    const table = await DiningTable.findOne({ _id: parseObjectId(raw, field), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.badRequest('That table is not in your kitchen.', { [field]: 'unknown table' });
    if (!table.is_active) throw ApiError.conflict(`${table.label} is unavailable.`, 'TABLE_UNAVAILABLE');
    return table;
  }

  async #server(kitchen, raw) {
    if (!raw) return null;
    const staff = await KitchenStaff.findOne({ _id: parseObjectId(raw, 'server_id'), vendor_id: kitchen.vendorId, is_current: true, deleted_at: null }).select('name is_active').lean();
    if (!staff || staff.is_active === false) throw ApiError.badRequest('Pick a server from your team.', { server_id: 'unknown employee' });
    return staff;
  }

  /**
   * Seats a party: a walk-in, someone from the waiting list, or (through
   * the reservation service) a booking. Refuses a table in use, switched off,
   * too small, or booked within the hour, unless the host confirms.
   */
  async seat(kitchen, body = {}, { reservation = null, checked = false } = {}) {
    // Seating a booking is checked by the reservation's own permissions.
    if (!checked) kitchen.assert('tables.seat');
    const table = await this.#table(kitchen, body.table_id);
    const count = guestCount(body.guest_count ?? reservation?.party_size, { required: true });
    if (table.capacity && count > table.capacity && body.allow_over_capacity !== true) {
      throw ApiError.conflict(`${table.label} seats ${table.capacity}. Confirm to seat ${count} anyway.`, 'TABLE_TOO_SMALL');
    }
    if (!reservation && body.ignore_reservation !== true) {
      const soon = new Date(Date.now() + SOON_MINUTES * 60000);
      const booked = await Reservation.findOne({ vendor_id: kitchen.vendorId, table_id: table._id, status: { $in: ['pending', 'confirmed', 'booked'] }, starts_at: { $lte: soon, $gte: new Date(Date.now() - 30 * 60000) } }).lean();
      if (booked) throw ApiError.conflict(`${table.label} is reserved for ${booked.name} at ${new Date(booked.starts_at).toLocaleTimeString('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit' })}. Confirm to seat here anyway.`, 'TABLE_RESERVED');
    }
    let waiting = null;
    if (body.waitlist_id) {
      waiting = await WaitlistEntry.findOne({ _id: parseObjectId(body.waitlist_id, 'waitlist_id'), vendor_id: kitchen.vendorId, status: 'waiting' }).lean();
      if (!waiting) throw ApiError.conflict('That party is no longer on the waiting list.', 'WAITLIST_ENTRY_GONE');
    }
    let server = null;
    if (body.server_id) {
      anyOf(kitchen, ['service.assign_servers', 'tables.seat', 'reservations.manage_sessions']);
      server = await this.#server(kitchen, body.server_id);
    } else if (table.assigned_staff_id) server = await KitchenStaff.findById(table.assigned_staff_id).select('name').lean();
    let session;
    try {
      session = (
        await TableSession.create({
          vendor_id: kitchen.vendorId,
          table_id: table._id,
          table_label: table.label,
          guest_count: count,
          customer_name: parseOptionalText(body.customer_name ?? waiting?.name ?? reservation?.name, { field: 'customer_name', max: 80 }) || '',
          customer_phone: parseOptionalText(body.customer_phone ?? waiting?.phone ?? reservation?.phone, { field: 'customer_phone', max: 20 }) || '',
          reservation_id: reservation?._id || null,
          server_id: server?._id || null,
          server_name: server?.name || '',
          source: reservation ? 'reservation' : 'host',
          notes: parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '',
          started_by: kitchen.actor,
        })
      ).toObject();
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict(`${table.label} is already occupied. Pick another table or move those guests first.`, 'TABLE_OCCUPIED');
      throw error;
    }
    if (waiting) await WaitlistEntry.updateOne({ _id: waiting._id, status: 'waiting' }, { $set: { status: 'seated', session_id: session._id, seated_at: new Date() } });
    if (server) {
      alerts.toStaff(kitchen.vendorId, server._id, { type: 'floor', title: `New table: ${table.label}`, body: `${count} guest${count === 1 ? '' : 's'}${session.customer_name ? ` (${session.customer_name})` : ''}`, link: '/vendor-dashboard/my-tables' });
    }
    await activity.record(kitchen, { action: 'session.seated', target_type: 'table', target_id: table._id, summary: `Seated ${count} at ${table.label}${server ? `, server ${server.name}` : ''}` });
    if (reservation) return { id: String(session._id) };
    return this.get(kitchen, session._id, { checked: true });
  }

  // --- the waiting list ---------------------------------------------------

  #waitView(w) {
    return { id: String(w._id), name: w.name, phone: w.phone || '', party_size: w.party_size, notes: w.notes || '', quoted_minutes: w.quoted_minutes ?? null, status: w.status, waiting_minutes: Math.round((Date.now() - new Date(w.created_at)) / 60000), created_at: w.created_at };
  }

  async waitlist(kitchen) {
    anyOf(kitchen, ['tables.waitlist', 'tables.seat']);
    const rows = await WaitlistEntry.find({ vendor_id: kitchen.vendorId, status: 'waiting' }).sort({ created_at: 1 }).lean();
    return { waitlist: rows.map((w) => this.#waitView(w)) };
  }

  async addToWaitlist(kitchen, body = {}) {
    anyOf(kitchen, ['tables.waitlist', 'tables.seat']);
    const name = parseOptionalText(body.name, { field: 'name', max: 80 });
    if (!name || name.length < 2) throw ApiError.badRequest('Whose party is it?', { name: 'required' });
    const quoted = body.quoted_minutes === undefined || body.quoted_minutes === '' ? null : Number(body.quoted_minutes);
    if (quoted !== null && (!Number.isInteger(quoted) || quoted < 0 || quoted > 600)) throw ApiError.badRequest('The wait is 0 to 600 minutes.', { quoted_minutes: 'expected 0-600' });
    const w = await WaitlistEntry.create({
      vendor_id: kitchen.vendorId,
      name,
      phone: parseOptionalText(body.phone, { field: 'phone', max: 20 }) || '',
      party_size: guestCount(body.party_size, { required: true }),
      notes: parseOptionalText(body.notes, { field: 'notes', max: 200 }) || '',
      quoted_minutes: quoted,
      added_by: kitchen.actor,
    });
    await activity.record(kitchen, { action: 'waitlist.added', target_type: 'waitlist', target_id: w._id, summary: `${name} (${w.party_size}) joined the waiting list` });
    return this.#waitView(w.toObject());
  }

  async updateWaitlist(kitchen, entryId, body = {}) {
    anyOf(kitchen, ['tables.waitlist', 'tables.seat']);
    const w = await WaitlistEntry.findOne({ _id: parseObjectId(entryId, 'waitlist_id'), vendor_id: kitchen.vendorId }).lean();
    if (!w) throw ApiError.notFound('That party is not on the waiting list.', 'WAITLIST_ENTRY_NOT_FOUND');
    const set = {};
    if (body.status !== undefined) {
      if (body.status !== 'left') throw ApiError.badRequest('Seat the party from the floor; here you can only mark that they left.', { status: 'expected left' });
      set.status = 'left';
    }
    if (body.quoted_minutes !== undefined) set.quoted_minutes = Number(body.quoted_minutes) || null;
    if (body.notes !== undefined) set.notes = parseOptionalText(body.notes, { field: 'notes', max: 200 }) || '';
    if (body.party_size !== undefined) set.party_size = guestCount(body.party_size, { required: true });
    const saved = await WaitlistEntry.findOneAndUpdate({ _id: w._id, status: 'waiting' }, { $set: set }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.conflict('That party was already seated or left.', 'WAITLIST_ENTRY_GONE');
    return this.#waitView(saved);
  }

  // --- during the visit ---------------------------------------------------

  async #live(kitchen, sessionId) {
    const s = await this.#load(kitchen, sessionId);
    if (s.status !== 'active') throw ApiError.conflict('This table visit is already closed.', 'SESSION_CLOSED');
    return s;
  }

  async update(kitchen, sessionId, body = {}) {
    const s = await this.#live(kitchen, sessionId);
    const set = {};
    if (body.guest_count !== undefined || body.customer_name !== undefined || body.notes !== undefined || body.customer_phone !== undefined) {
      anyOf(kitchen, ['tables.seat', 'tables.sessions_view', 'service.view_assigned']);
      this.#assertMine(kitchen, s);
      if (body.guest_count !== undefined) set.guest_count = guestCount(body.guest_count, { required: true });
      if (body.customer_name !== undefined) set.customer_name = parseOptionalText(body.customer_name, { field: 'customer_name', max: 80 }) || '';
      if (body.customer_phone !== undefined) set.customer_phone = parseOptionalText(body.customer_phone, { field: 'customer_phone', max: 20 }) || '';
      if (body.notes !== undefined) set.notes = parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '';
    }
    if (!Object.keys(set).length) throw ApiError.badRequest('Nothing to change.', {});
    await TableSession.updateOne({ _id: s._id, status: 'active' }, { $set: set });
    return this.get(kitchen, s._id, { checked: true });
  }

  /** Gives the table to a server (or moves it to another one). */
  async assignServer(kitchen, sessionId, body = {}) {
    const s = await this.#live(kitchen, sessionId);
    anyOf(kitchen, s.server_id ? ['service.transfer_servers', 'service.assign_servers'] : ['service.assign_servers', 'tables.seat']);
    const server = body.server_id ? await this.#server(kitchen, body.server_id) : null;
    await TableSession.updateOne({ _id: s._id, status: 'active' }, { $set: { server_id: server?._id || null, server_name: server?.name || '' } });
    await Order.updateMany(
      { table_session_id: s._id, status: { $nin: DONE } },
      { $set: { assigned_staff: server ? { type: 'staff', id: String(server._id), name: server.name } : null } }
    );
    if (server) alerts.toStaff(kitchen.vendorId, server._id, { type: 'floor', title: `${s.table_label} is yours`, body: s.server_name ? `Moved from ${s.server_name}.` : 'You look after this table now.', link: '/vendor-dashboard/my-tables' });
    await activity.record(kitchen, { action: 'session.server', target_type: 'table', target_id: s.table_id, summary: `${s.table_label}: server ${server ? server.name : 'removed'}${s.server_name ? ` (was ${s.server_name})` : ''}` });
    return this.get(kitchen, s._id, { checked: true });
  }

  /**
   * Moves the guests to another (free) table: the visit, its open orders
   * and its bill follow. To join two occupied tables, merge them instead.
   */
  async transfer(kitchen, sessionId, body = {}) {
    kitchen.assert('tables.transfer_sessions');
    const s = await this.#live(kitchen, sessionId);
    const target = await this.#table(kitchen, body.table_id);
    if (String(target._id) === String(s.table_id)) throw ApiError.badRequest('The guests are already at that table.', { table_id: 'same table' });
    const occupied = await TableSession.exists({ vendor_id: kitchen.vendorId, table_id: target._id, status: 'active' });
    if (occupied) throw ApiError.conflict(`${target.label} is occupied. Merge the tables instead.`, 'TABLE_OCCUPIED');
    const openBill = await Invoice.exists({ table_id: target._id, kind: 'table', is_open: true });
    if (openBill) throw ApiError.conflict(`${target.label} still has an open bill. Close it first.`, 'TABLE_HAS_OPEN_BILL');
    try {
      const moved = await TableSession.updateOne(
        { _id: s._id, status: 'active', table_id: s.table_id },
        { $set: { table_id: target._id, table_label: target.label }, $push: { transfers: { from_label: s.table_label, to_label: target.label, at: new Date(), by: kitchen.actor.name } } }
      );
      if (!moved.modifiedCount) throw ApiError.conflict('This table visit just changed. Refresh and try again.', 'SESSION_CHANGED');
    } catch (error) {
      if (isDuplicate(error)) throw ApiError.conflict(`${target.label} was just taken.`, 'TABLE_OCCUPIED');
      throw error;
    }
    await Invoice.updateMany({ session_id: s._id, is_open: true }, { $set: { table_id: target._id, table_label: target.label } });
    await Order.updateMany(
      { table_session_id: s._id, status: { $nin: DONE } },
      { $set: { table: { table_id: target._id, label: target.label } }, $push: { status_history: { status: 'placed', at: new Date(), note: `Guests moved from ${s.table_label} to ${target.label}` } } }
    );
    await activity.record(kitchen, { action: 'session.transferred', target_type: 'table', target_id: target._id, summary: `Moved guests from ${s.table_label} to ${target.label}` });
    return this.get(kitchen, s._id, { checked: true });
  }

  /** A server takes the guests' order (priced on the server, like a QR order). */
  async order(kitchen, sessionId, body = {}) {
    kitchen.assert('service.order_for_guests');
    const s = await this.#live(kitchen, sessionId);
    this.#assertMine(kitchen, s);
    if (s.status === 'closing') throw ApiError.conflict('This table is being closed. Reopen it to order more.', 'SESSION_CLOSING');
    const tableOrders = require('./tableOrderService');
    const lines = tableOrders.parseLines(body);
    const [table, vendor] = await Promise.all([DiningTable.findById(s.table_id).lean(), Vendor.findById(kitchen.vendorId).lean()]);
    if (!table || table.deleted_at) throw ApiError.conflict('This table was removed.', 'TABLE_NOT_FOUND');
    const { order } = await tableOrders.createDineInOrder({
      vendor,
      table,
      session: s,
      lines,
      guestName: s.customer_name,
      note: parseOptionalText(body.note, { field: 'note', max: 300 }) || '',
      source: 'staff',
      actor: kitchen.actor,
    });
    return { order: { id: String(order._id), order_number: order.order_number, total_rwf: order.total_rwf, status: order.status }, session: await this.get(kitchen, s._id, { checked: true }) };
  }

  /** The menu a server orders from for this table (same dishes and prices the guests see). */
  async menu(kitchen, sessionId) {
    kitchen.assert('service.order_for_guests');
    const s = await this.#live(kitchen, sessionId);
    this.#assertMine(kitchen, s);
    const table = await DiningTable.findById(s.table_id).select('token').lean();
    const menu = await require('./tableOrderService').menu(table.token);
    return { kitchen: { name: menu.kitchen?.name || '' }, menu: menu.kitchen?.menu || [], departments: menu.departments };
  }

  // --- closing ------------------------------------------------------------

  /**
   * Closes the visit when the kitchen's rules are met (orders finished,
   * bill paid, packing handed over...). A manager can close anyway with a
   * reason; what was still open is kept on the record. The table is free again.
   */
  async close(kitchen, sessionId, body = {}) {
    anyOf(kitchen, ['tables.close_sessions', 'reservations.manage_sessions', 'reservations.extend_close']);
    const s = await this.#live(kitchen, sessionId);
    const [summaries, rules] = await Promise.all([this.#summaries([s]), this.#rules(kitchen.vendorId)]);
    const { blockers } = this.#blockers(summaries.get(String(s._id)), rules);
    let exceptions = [];
    if (blockers.length) {
      if (body.override !== true) {
        throw new ApiError(409, 'SESSION_NOT_READY', `This table can't close yet: ${blockers.map((b) => b.message).join(' ')}`, { blockers: blockers.map((b) => b.code) });
      }
      kitchen.assert('tables.session_override');
      const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 });
      if (!reason) throw ApiError.badRequest('Say why the table is closed with things still open.', { reason: 'required' });
      exceptions = [...blockers.map((b) => b.message), `Reason: ${reason}`];
    }
    const now = new Date();
    const done = await TableSession.findOneAndUpdate(
      { _id: s._id, status: 'active' },
      {
        $set: {
          status: 'closed',
          closed_at: now,
          closed_by: kitchen.actor,
          close_exceptions: exceptions,
          // Guests' seat sessions end with the visit; pending "pay for me" grants expire.
          'customer_sessions.$[seat].status': 'closed',
          'customer_sessions.$[seat].closed_at': now,
          'payment_authorizations.$[grant].status': 'expired',
          'payment_authorizations.$[grant].token_hash': null,
        },
      },
      { arrayFilters: [{ 'seat.status': 'active' }, { 'grant.status': { $in: ['pending', 'authorized'] } }], returnDocument: 'after' }
    ).lean();
    if (!done) throw ApiError.conflict('This table was just closed by someone else.', 'SESSION_CLOSED');
    // The bill stops taking new orders; an unpaid one stays in outstanding bills.
    await Invoice.updateMany({ session_id: s._id, is_open: true }, { $set: { is_open: false, closed_at: now } });
    if (s.reservation_id) await require('./reservationService').completeFromSession(s.reservation_id, kitchen.actor);
    await activity.record(kitchen, {
      action: exceptions.length ? 'session.closed_override' : 'session.closed',
      target_type: 'table',
      target_id: s.table_id,
      summary: `Closed ${s.table_label}${exceptions.length ? ` with open items (${exceptions.join(' ')})` : ''}`,
    });
    return this.get(kitchen, s._id, { checked: true });
  }

  /** The table visits a report covers (utilisation, time at table). */
  async forReport(vendorId, from, to) {
    return TableSession.find({ vendor_id: vendorId, started_at: { $lt: to }, $or: [{ closed_at: null }, { closed_at: { $gte: from } }] })
      .select('table_id table_label guest_count started_at closed_at server_name source close_exceptions')
      .lean();
  }
}

module.exports = new SessionService();
module.exports.LIVE = LIVE;

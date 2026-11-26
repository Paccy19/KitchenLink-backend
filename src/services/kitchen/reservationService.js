const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { Reservation, DiningTable, Invoice, MenuItem, Order, TableSession, Vendor } = require('../../models');
const access = require('../../config/kitchenAccess');
const alerts = require('./alertService');
const activity = require('./activityService');

/**
 * Reservations, from the booking to the end of the visit:
 *   pending (asked online) -> confirmed -> arrived -> seated -> completed
 *   or rejected (by the kitchen), cancelled, no_show.
 * Seating opens the table visit (TableSession); a paid deposit counts on
 * the visit's bill; pre-ordered dishes go to the kitchen only when the
 * guests are seated, never before. 'booked' is the older name of 'confirmed'.
 */
const HOLDS_TABLE = ['pending', 'confirmed', 'booked', 'arrived', 'seated'];
const UPCOMING = ['pending', 'confirmed', 'booked', 'arrived'];
const STATUSES = ['pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'rejected', 'no_show'];
const DEFAULTS = { enabled_online: true, duration_minutes: 90, buffer_minutes: 15, max_party: 12, require_confirmation: true, deposit_per_guest_rwf: 0, refund_deposit_hours: 24, keep_deposit_on_no_show: true, preorders: true, preorder_lead_minutes: 0, reminder_minutes: 120 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const KIGALI_OFFSET = 2 * 3600000;

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const status = (s) => (s === 'booked' ? 'confirmed' : s);
const anyOf = (kitchen, perms) => {
  if (!perms.some((p) => kitchen.can(p))) kitchen.assert(perms[0]);
};
const kigaliTime = (d) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kigali', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const serialize = (r, { publicView = false } = {}) => {
  const out = {
    id: String(r._id),
    name: r.name,
    phone: r.phone || '',
    email: r.email || '',
    party_size: r.party_size,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    duration_minutes: r.duration_minutes,
    table: r.table_id ? { id: String(r.table_id), label: r.table_label } : null,
    status: status(r.status),
    special_requests: r.special_requests || '',
    dietary_notes: r.dietary_notes || '',
    source: r.source || 'staff',
    preorder_items: (r.preorder_items || []).map((i) => ({ menu_item_id: String(i.menu_item_id), name: i.name, quantity: i.quantity, note: i.note || '' })),
    preorder_sent: Boolean(r.preorder_order_id),
    deposit: {
      required_rwf: r.deposit?.required_rwf || 0,
      paid_rwf: r.deposit?.paid_rwf || 0,
      applied_rwf: r.deposit?.applied_rwf || 0,
      status: r.deposit?.status || 'none',
    },
    confirmed_at: r.confirmed_at || null,
    arrived_at: r.arrived_at || null,
    seated_at: r.seated_at || null,
    cancelled_at: r.cancelled_at || null,
    created_at: r.created_at,
  };
  if (!publicView) {
    out.notes = r.notes || '';
    out.created_by = r.created_by?.name || '';
    out.session_id = r.session_id ? String(r.session_id) : null;
    out.deposit.method = r.deposit?.method || '';
    out.deposit.reference = r.deposit?.reference || '';
    out.deposit.note = r.deposit?.note || '';
    out.history = (r.history || []).map((h) => ({ status: status(h.status), at: h.at, by: h.by || '', note: h.note || '' }));
    out.allowed_next_statuses = NEXT[status(r.status)] || [];
  }
  return out;
};

// What can happen next (the server decides; screens show these as buttons).
const NEXT = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['arrived', 'seated', 'cancelled', 'no_show'],
  arrived: ['seated', 'cancelled'],
  seated: ['completed'],
};

const parseWhen = (raw, field = 'starts_at') => {
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) throw ApiError.badRequest('Pick the date and time.', { [field]: 'expected a date and time' });
  return d;
};
const parseParty = (raw, max = 200) => {
  const party = Number(raw);
  if (!Number.isInteger(party) || party < 1 || party > max) throw ApiError.badRequest(max < 200 ? `Online bookings are for 1 to ${max} guests. Call the kitchen for bigger groups.` : 'How many guests?', { party_size: `expected 1-${max}` });
  return party;
};

class ReservationService {
  async settings(vendorId) {
    const v = await Vendor.findById(vendorId).select('operations.reservations operating_hours name verification_status deleted_at').lean();
    return { vendor: v, rules: { ...DEFAULTS, ...(v?.operations?.reservations || {}) } };
  }

  async #load(kitchen, id) {
    const r = await Reservation.findOne({ _id: parseObjectId(id, 'reservation_id'), vendor_id: kitchen.vendorId }).lean();
    if (!r) throw ApiError.notFound('Reservation not found.', 'RESERVATION_NOT_FOUND');
    return r;
  }

  /** Moves a booking on only from the status it was read in (two hosts can't both do it). */
  async #move(r, to, set = {}, { by = '', note = '' } = {}) {
    const from = status(r.status);
    if (!(NEXT[from] || []).includes(to)) {
      throw ApiError.conflict(`A ${from.replace('_', ' ')} booking can't become ${to.replace('_', ' ')}.`, 'INVALID_RESERVATION_STATUS');
    }
    const saved = await Reservation.findOneAndUpdate(
      { _id: r._id, status: r.status },
      { $set: { status: to, ...set }, $push: { history: { status: to, at: new Date(), by, note } } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('This booking just changed. Refresh and try again.', 'RESERVATION_CHANGED');
    return saved;
  }

  async list(kitchen, query = {}) {
    if (!access.inGroup('reservations').some((p) => kitchen.can(p))) kitchen.assert('reservations.view');
    const from = query.from ? parseWhen(query.from, 'from') : new Date(Date.now() - 6 * 3600000);
    const to = query.to ? parseWhen(query.to, 'to') : new Date(from.getTime() + 14 * 86400000);
    const filter = { vendor_id: kitchen.vendorId, starts_at: { $gte: from, $lte: to } };
    if (STATUSES.includes(query.status) || query.status === 'booked') filter.status = ['confirmed', 'booked'].includes(query.status) ? { $in: ['confirmed', 'booked'] } : query.status;
    const rows = await Reservation.find(filter).sort({ starts_at: 1 }).limit(300).lean();
    const counts = rows.reduce((acc, r) => ({ ...acc, [status(r.status)]: (acc[status(r.status)] || 0) + 1 }), {});
    return { reservations: rows.map((r) => serialize(r)), counts };
  }

  async get(kitchen, id) {
    kitchen.assert('reservations.view');
    return serialize(await this.#load(kitchen, id));
  }

  /** A table is taken if another booking holding it overlaps the time, buffer included. */
  async #assertTableFree(vendorId, tableId, startsAt, endsAt, bufferMinutes, exceptId = null) {
    const buffer = bufferMinutes * 60000;
    const clash = await Reservation.findOne({
      vendor_id: vendorId,
      table_id: tableId,
      status: { $in: HOLDS_TABLE },
      starts_at: { $lt: new Date(endsAt.getTime() + buffer) },
      ends_at: { $gt: new Date(startsAt.getTime() - buffer) },
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    }).lean();
    if (clash) throw ApiError.conflict(`That table is booked for ${clash.name} around that time.`, 'TABLE_BOOKED');
  }

  async #table(vendorId, raw) {
    if (!raw) return null;
    const table = await DiningTable.findOne({ _id: parseObjectId(raw, 'table_id'), vendor_id: vendorId, deleted_at: null }).lean();
    if (!table) throw ApiError.badRequest('That table is not in your kitchen.', { table_id: 'unknown table' });
    if (!table.is_active) throw ApiError.conflict('That table is switched off.', 'TABLE_INACTIVE');
    return table;
  }

  async #preorder(vendorId, raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 30) throw ApiError.badRequest('Pre-order up to 30 dishes.', { preorder_items: 'expected a list' });
    const ids = raw.map((l, i) => parseObjectId(l?.menu_item_id, `preorder_items[${i}].menu_item_id`));
    const dishes = await MenuItem.find({ _id: { $in: ids }, vendor_id: vendorId, deleted_at: null, is_available: true }).select('name').lean();
    const byId = new Map(dishes.map((d) => [String(d._id), d]));
    return raw.map((l, i) => {
      const dish = byId.get(String(ids[i]));
      if (!dish) throw ApiError.conflict('A pre-ordered dish is not available any more.', 'CART_ITEM_UNAVAILABLE');
      const quantity = Number(l.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw ApiError.badRequest('Quantities are 1 to 50.', { [`preorder_items[${i}].quantity`]: 'expected 1-50' });
      return { menu_item_id: dish._id, name: dish.name, quantity, note: parseOptionalText(l.note, { field: `preorder_items[${i}].note`, max: 140 }) || '' };
    });
  }

  #duration(raw, fallback) {
    const duration = Number(raw ?? fallback);
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw ApiError.badRequest('Duration is 15 minutes to 12 hours.', { duration_minutes: 'expected 15-720' });
    return duration;
  }

  /** A booking taken by the kitchen (phone, at the door). Confirmed straight away. */
  async create(kitchen, body = {}) {
    kitchen.assert('reservations.create');
    const { rules } = await this.settings(kitchen.vendorId);
    const startsAt = parseWhen(body.starts_at);
    const duration = this.#duration(body.duration_minutes, rules.duration_minutes);
    const party = parseParty(body.party_size);
    const endsAt = new Date(startsAt.getTime() + duration * 60000);
    let table = null;
    if (body.table_id) {
      kitchen.assert('reservations.assign_tables');
      table = await this.#table(kitchen.vendorId, body.table_id);
      await this.#assertTableFree(kitchen.vendorId, table._id, startsAt, endsAt, rules.buffer_minutes);
    }
    const preorder = body.preorder_items !== undefined ? (kitchen.assert('reservations.preorders'), await this.#preorder(kitchen.vendorId, body.preorder_items)) : [];
    const required = Number.isInteger(Number(body.deposit_required_rwf)) && body.deposit_required_rwf !== undefined
      ? (kitchen.assert('reservations.deposits'), Math.max(0, Number(body.deposit_required_rwf)))
      : (rules.deposit_per_guest_rwf || 0) * party;
    const r = await Reservation.create({
      vendor_id: kitchen.vendorId,
      name: parseRequiredText(body.name, { field: 'name', min: 2, max: 80 }),
      phone: parseOptionalText(body.phone, { field: 'phone', max: 20 }) || '',
      email: parseOptionalText(body.email, { field: 'email', max: 120 }) || '',
      party_size: party,
      starts_at: startsAt,
      duration_minutes: duration,
      ends_at: endsAt,
      table_id: table?._id || null,
      table_label: table?.label || '',
      status: 'confirmed',
      confirmed_at: new Date(),
      source: 'staff',
      special_requests: parseOptionalText(body.special_requests, { field: 'special_requests', max: 300 }) || '',
      dietary_notes: parseOptionalText(body.dietary_notes, { field: 'dietary_notes', max: 300 }) || '',
      notes: parseOptionalText(body.notes, { field: 'notes', max: 300 }) || '',
      preorder_items: preorder,
      deposit: { required_rwf: required, status: required > 0 ? 'required' : 'none' },
      history: [{ status: 'confirmed', at: new Date(), by: kitchen.actor.name, note: 'Booked by the kitchen' }],
      created_by: kitchen.actor,
    });
    alerts.emit(kitchen.vendorId, 'reservations', { title: `New booking: ${r.name} (${party})`, body: kigaliTime(startsAt), link: '/vendor-dashboard/reservations', permission: 'reservations.view' });
    await activity.record(kitchen, { action: 'reservation.created', target_type: 'reservation', target_id: r._id, summary: `Booked ${r.name} for ${party}` });
    return serialize(r.toObject());
  }

  /** Booking details (who, when, table, notes). Status changes have their own steps. */
  async update(kitchen, reservationId, body = {}) {
    const r = await this.#load(kitchen, reservationId);
    // Older screens send { status }: each goes through its proper step.
    if (body.status !== undefined) {
      const to = status(String(body.status));
      if (to === 'seated') {
        anyOf(kitchen, ['reservations.manage_sessions', 'tables.seat', 'reservations.edit']);
        return this.seat(kitchen, r._id, body, { checked: true });
      }
      if (to === 'cancelled') return this.cancel(kitchen, r._id, body);
      if (to === 'no_show') return this.noShow(kitchen, r._id);
      if (to === 'confirmed') return this.confirm(kitchen, r._id);
      if (to === 'arrived') return this.arrive(kitchen, r._id);
      if (to === 'rejected') return this.reject(kitchen, r._id, body);
      if (to === 'completed') {
        anyOf(kitchen, ['reservations.extend_close', 'reservations.edit']);
        const done = await this.#move(r, 'completed', {}, { by: kitchen.actor.name });
        return serialize(done);
      }
      throw ApiError.badRequest('Unknown status.', { status: `expected one of: ${STATUSES.join(', ')}` });
    }
    if (['completed', 'cancelled', 'rejected', 'no_show'].includes(status(r.status))) throw ApiError.conflict('This booking is finished and can no longer be changed.', 'RESERVATION_FINISHED');
    const { rules } = await this.settings(kitchen.vendorId);
    const set = {};
    const changesBooking = ['name', 'phone', 'email', 'party_size', 'starts_at', 'notes', 'special_requests', 'dietary_notes'].some((f) => body[f] !== undefined);
    if (changesBooking) {
      kitchen.assert('reservations.edit');
      if (body.name !== undefined) set.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 80 });
      if (body.phone !== undefined) set.phone = parseOptionalText(body.phone, { field: 'phone', max: 20 }) || '';
      if (body.email !== undefined) set.email = parseOptionalText(body.email, { field: 'email', max: 120 }) || '';
      for (const f of ['notes', 'special_requests', 'dietary_notes']) if (body[f] !== undefined) set[f] = parseOptionalText(body[f], { field: f, max: 300 }) || '';
      if (body.party_size !== undefined) set.party_size = parseParty(body.party_size);
      if (body.starts_at !== undefined) set.starts_at = parseWhen(body.starts_at);
    }
    if (body.duration_minutes !== undefined) {
      anyOf(kitchen, ['reservations.extend_close', 'reservations.edit']);
      set.duration_minutes = this.#duration(body.duration_minutes);
    }
    if (body.preorder_items !== undefined) {
      kitchen.assert('reservations.preorders');
      if (r.preorder_order_id) throw ApiError.conflict('The pre-order is already with the kitchen. Change it on the order.', 'PREORDER_SENT');
      set.preorder_items = await this.#preorder(kitchen.vendorId, body.preorder_items);
    }
    if (body.deposit_required_rwf !== undefined) {
      kitchen.assert('reservations.deposits');
      const amount = Number(body.deposit_required_rwf);
      if (!Number.isInteger(amount) || amount < 0 || amount > 10000000) throw ApiError.badRequest('Enter the deposit in whole RWF.', { deposit_required_rwf: 'expected a whole amount' });
      set['deposit.required_rwf'] = amount;
      if (['none', 'required'].includes(r.deposit?.status || 'none')) set['deposit.status'] = amount > 0 ? 'required' : 'none';
    }
    const startsAt = set.starts_at || r.starts_at;
    const duration = set.duration_minutes || r.duration_minutes;
    set.ends_at = new Date(new Date(startsAt).getTime() + duration * 60000);
    if (body.table_id !== undefined) {
      kitchen.assert('reservations.assign_tables');
      const table = await this.#table(kitchen.vendorId, body.table_id);
      set.table_id = table?._id || null;
      set.table_label = table?.label || '';
    }
    const tableId = set.table_id !== undefined ? set.table_id : r.table_id;
    if (tableId && HOLDS_TABLE.includes(r.status) && r.status !== 'seated') await this.#assertTableFree(kitchen.vendorId, tableId, new Date(startsAt), set.ends_at, rules.buffer_minutes, r._id);
    const saved = await Reservation.findOneAndUpdate({ _id: r._id, status: r.status }, { $set: set }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.conflict('This booking just changed. Refresh and try again.', 'RESERVATION_CHANGED');
    await activity.record(kitchen, { action: 'reservation.updated', target_type: 'reservation', target_id: r._id, summary: `Booking of ${saved.name}: ${Object.keys(set).filter((k) => k !== 'ends_at').join(', ')}` });
    return serialize(saved);
  }

  async #tellGuest(r, title, body) {
    if (!r.customer_id) return;
    require('../notificationService').notifyCustomers([r.customer_id], { type: 'general', title, body, link: '/reservations' }).catch(() => null);
  }

  async confirm(kitchen, id) {
    kitchen.assert('reservations.confirm');
    const r = await this.#load(kitchen, id);
    if (r.table_id) {
      const { rules } = await this.settings(kitchen.vendorId);
      await this.#assertTableFree(kitchen.vendorId, r.table_id, new Date(r.starts_at), new Date(r.ends_at), rules.buffer_minutes, r._id);
    }
    const saved = await this.#move(r, 'confirmed', { confirmed_at: new Date() }, { by: kitchen.actor.name });
    this.#tellGuest(saved, 'Your table is booked', `${saved.party_size} guests, ${kigaliTime(saved.starts_at)}.`);
    await activity.record(kitchen, { action: 'reservation.confirmed', target_type: 'reservation', target_id: r._id, summary: `Confirmed ${r.name}` });
    return serialize(saved);
  }

  async reject(kitchen, id, body = {}) {
    kitchen.assert('reservations.confirm');
    const r = await this.#load(kitchen, id);
    const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 }) || '';
    const set = { cancelled_at: new Date() };
    if ((r.deposit?.paid_rwf || 0) > 0) Object.assign(set, { 'deposit.status': 'refunded', 'deposit.settled_at': new Date(), 'deposit.note': 'Booking declined: give the deposit back' });
    const saved = await this.#move(r, 'rejected', set, { by: kitchen.actor.name, note: reason });
    this.#tellGuest(saved, 'Your booking could not be accepted', reason || 'The kitchen is fully booked at that time.');
    await activity.record(kitchen, { action: 'reservation.rejected', target_type: 'reservation', target_id: r._id, summary: `Declined ${r.name}${reason ? `: ${reason}` : ''}` });
    return serialize(saved);
  }

  /** The guests are here (waiting to be seated). */
  async arrive(kitchen, id) {
    anyOf(kitchen, ['reservations.check_in', 'tables.seat']);
    const r = await this.#load(kitchen, id);
    const saved = await this.#move(r, 'arrived', { arrived_at: new Date() }, { by: kitchen.actor.name });
    alerts.emit(kitchen.vendorId, 'reservations', { title: `${r.name} (${r.party_size}) has arrived`, body: r.table_label ? `Booked ${r.table_label}` : 'No table assigned yet', link: '/vendor-dashboard/floor', permission: 'tables.seat' });
    await activity.record(kitchen, { action: 'reservation.arrived', target_type: 'reservation', target_id: r._id, summary: `${r.name} arrived` });
    return serialize(saved);
  }

  /**
   * Seats the booking: opens the table visit, sends the pre-order to the
   * kitchen, and counts a paid deposit on the bill.
   */
  async seat(kitchen, id, body = {}, { checked = false } = {}) {
    if (!checked) anyOf(kitchen, ['reservations.manage_sessions', 'tables.seat']);
    const r = await this.#load(kitchen, id);
    if (!(NEXT[status(r.status)] || []).includes('seated')) throw ApiError.conflict(`A ${status(r.status).replace('_', ' ')} booking can't be seated.`, 'INVALID_RESERVATION_STATUS');
    const tableId = body.table_id || r.table_id;
    if (!tableId) throw ApiError.badRequest('Pick the table to seat them at.', { table_id: 'required' });
    const sessions = require('./sessionService');
    const session = await sessions.seat(
      kitchen,
      { table_id: tableId, guest_count: body.guest_count ?? r.party_size, server_id: body.server_id, allow_over_capacity: body.allow_over_capacity, notes: [r.special_requests, r.dietary_notes].filter(Boolean).join(' · ') },
      { reservation: r, checked: true }
    );
    const table = await DiningTable.findById(tableId).select('label').lean();
    const saved = await this.#move(r, 'seated', { seated_at: new Date(), session_id: session.id, table_id: tableId, table_label: table?.label || r.table_label }, { by: kitchen.actor.name });
    await this.#sendPreorder(saved, kitchen.actor);
    await this.applyDeposit(saved._id);
    await activity.record(kitchen, { action: 'reservation.seated', target_type: 'reservation', target_id: r._id, summary: `Seated ${r.name} at ${table?.label || 'a table'}` });
    return serialize(await Reservation.findById(r._id).lean());
  }

  /** Pre-ordered dishes go to the kitchen now (as one order on the visit's bill). */
  async #sendPreorder(r, actor) {
    if (!r.preorder_items?.length || r.preorder_order_id || !r.session_id) return;
    const claimed = await Reservation.findOneAndUpdate({ _id: r._id, preorder_order_id: null }, { $set: { preorder_order_id: new mongoose.Types.ObjectId() } }, { returnDocument: 'after' }).lean();
    if (!claimed) return;
    try {
      const [session, vendor] = await Promise.all([TableSession.findById(r.session_id).lean(), Vendor.findById(r.vendor_id).lean()]);
      const table = await DiningTable.findById(session.table_id).lean();
      const { order } = await require('./tableOrderService').createDineInOrder({
        vendor,
        table,
        session,
        lines: r.preorder_items.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.quantity, note: i.note, option_ids: [] })),
        guestName: r.name,
        note: 'Pre-ordered with the booking',
        source: 'reservation',
        actor,
        reservationId: r._id,
      });
      await Reservation.updateOne({ _id: r._id }, { $set: { preorder_order_id: order._id } });
    } catch (error) {
      // A dish went off the menu: the server takes the order at the table instead.
      await Reservation.updateOne({ _id: r._id }, { $set: { preorder_order_id: null }, $push: { history: { status: 'seated', at: new Date(), by: 'system', note: `Pre-order not sent: ${error.message}` } } });
      alerts.emit(r.vendor_id, 'reservations', { title: `Pre-order for ${r.name} not sent`, body: error.message, link: '/vendor-dashboard/floor', permission: 'service.order_for_guests' });
    }
  }

  /** A paid deposit counts on the visit's bill as orders arrive (never more than is due). */
  async applyDeposit(reservationId) {
    const r = await Reservation.findById(reservationId).lean();
    if (!r?.session_id || !['paid', 'applied'].includes(r.deposit?.status)) return 0;
    const left = (r.deposit.paid_rwf || 0) - (r.deposit.applied_rwf || 0);
    if (left <= 0) return 0;
    const bill = await Invoice.findOne({ session_id: r.session_id, kind: 'table', status: { $in: ['unpaid', 'partially_paid'] } }).sort({ created_at: 1 }).lean();
    if (!bill) return 0;
    // Claim the amount on the reservation first, so it can only ever be used once.
    const claim = Math.min(left, bill.total_rwf - bill.amount_paid_rwf);
    if (claim <= 0) return 0;
    const claimed = await Reservation.updateOne({ _id: r._id, 'deposit.applied_rwf': r.deposit.applied_rwf || 0 }, { $inc: { 'deposit.applied_rwf': claim } });
    if (!claimed.modifiedCount) return 0;
    const taken = await require('./invoiceService').applyDeposit(bill._id, claim, { reference: `Booking ${r.name}`, actor: { type: 'system', name: 'Reservation deposit' } });
    const unused = claim - taken;
    const fully = (r.deposit.applied_rwf || 0) + taken >= r.deposit.paid_rwf;
    await Reservation.updateOne({ _id: r._id }, { $inc: { 'deposit.applied_rwf': -unused }, ...(fully ? { $set: { 'deposit.status': 'applied', 'deposit.settled_at': new Date() } } : {}) });
    return taken;
  }

  /** The visit ended (its table was closed). */
  async completeFromSession(reservationId, actor) {
    const r = await Reservation.findById(reservationId).lean();
    if (!r || r.status !== 'seated') return;
    await Reservation.updateOne({ _id: r._id, status: 'seated' }, { $set: { status: 'completed' }, $push: { history: { status: 'completed', at: new Date(), by: actor?.name || '', note: 'Table closed' } } });
  }

  /**
   * Cancelled by the guest or the kitchen. A paid deposit is given back when
   * cancelled early enough (the kitchen's notice period), otherwise kept;
   * someone allowed to handle deposits can decide otherwise.
   */
  async cancel(kitchen, id, body = {}) {
    kitchen.assert('reservations.cancel');
    const r = await this.#load(kitchen, id);
    const { rules } = await this.settings(kitchen.vendorId);
    const set = { cancelled_at: new Date(), ...this.#depositOnCancel(r, rules, body, kitchen) };
    const saved = await this.#move(r, 'cancelled', set, { by: kitchen.actor.name, note: parseOptionalText(body.reason, { field: 'reason', max: 200 }) || '' });
    this.#tellGuest(saved, 'Your booking was cancelled', `${kigaliTime(saved.starts_at)}.`);
    await activity.record(kitchen, { action: 'reservation.cancelled', target_type: 'reservation', target_id: r._id, summary: `Cancelled ${r.name}${set['deposit.status'] ? ` (deposit ${set['deposit.status']})` : ''}` });
    return serialize(saved);
  }

  #depositOnCancel(r, rules, body, kitchen) {
    if (!((r.deposit?.paid_rwf || 0) > 0) || !['paid'].includes(r.deposit?.status)) return {};
    const hoursBefore = (new Date(r.starts_at) - Date.now()) / 3600000;
    let refund = hoursBefore >= rules.refund_deposit_hours;
    if (body.refund_deposit !== undefined && kitchen) {
      kitchen.assert('reservations.deposits');
      refund = body.refund_deposit === true;
    }
    return { 'deposit.status': refund ? 'refunded' : 'forfeited', 'deposit.settled_at': new Date(), 'deposit.note': refund ? 'Give the deposit back' : 'Kept (late cancellation)' };
  }

  async noShow(kitchen, id) {
    anyOf(kitchen, ['reservations.cancel', 'reservations.edit', 'reservations.check_in']);
    const r = await this.#load(kitchen, id);
    if (new Date(r.starts_at) > new Date()) throw ApiError.conflict('The booking time has not come yet.', 'TOO_EARLY');
    const { rules } = await this.settings(kitchen.vendorId);
    const set = {};
    if ((r.deposit?.paid_rwf || 0) > 0 && r.deposit.status === 'paid') {
      Object.assign(set, rules.keep_deposit_on_no_show
        ? { 'deposit.status': 'forfeited', 'deposit.settled_at': new Date(), 'deposit.note': 'Kept: the guests did not come' }
        : { 'deposit.status': 'refunded', 'deposit.settled_at': new Date(), 'deposit.note': 'Give the deposit back' });
    }
    const saved = await this.#move(r, 'no_show', set, { by: kitchen.actor.name });
    await activity.record(kitchen, { action: 'reservation.no_show', target_type: 'reservation', target_id: r._id, summary: `${r.name} did not come` });
    return serialize(saved);
  }

  /** A deposit taken (cash, mobile money, card...). Applied to the bill once seated. */
  async recordDeposit(kitchen, id, body = {}) {
    kitchen.assert('reservations.deposits');
    const r = await this.#load(kitchen, id);
    if (!UPCOMING.includes(r.status) && r.status !== 'seated') throw ApiError.conflict('This booking is finished.', 'RESERVATION_FINISHED');
    const amount = Number(body.amount_rwf);
    if (!Number.isInteger(amount) || amount < 1 || amount > 10000000) throw ApiError.badRequest('Enter the amount in whole RWF.', { amount_rwf: 'expected a positive whole amount' });
    const method = String(body.method || 'cash');
    const methods = access.IN_PERSON_METHODS.map((m) => m.id);
    if (!methods.includes(method)) throw ApiError.badRequest('Pick how the deposit was paid.', { method: `expected one of: ${methods.join(', ')}` });
    const saved = await Reservation.findOneAndUpdate(
      { _id: r._id, 'deposit.paid_rwf': r.deposit?.paid_rwf || 0, 'deposit.status': { $nin: ['refunded', 'forfeited'] } },
      {
        $inc: { 'deposit.paid_rwf': amount },
        $set: { 'deposit.method': method, 'deposit.reference': parseOptionalText(body.reference, { field: 'reference', max: 80 }) || '', 'deposit.paid_at': new Date(), 'deposit.status': 'paid' },
        $push: { history: { status: status(r.status), at: new Date(), by: kitchen.actor.name, note: `Deposit RWF ${amount.toLocaleString('en-US')} (${method})` } },
      },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) throw ApiError.conflict('The deposit just changed. Refresh and try again.', 'RESERVATION_CHANGED');
    if (saved.status === 'seated') await this.applyDeposit(saved._id);
    alerts.emit(kitchen.vendorId, 'reservations', { title: `Deposit received: ${r.name}`, body: `RWF ${amount.toLocaleString('en-US')}`, link: '/vendor-dashboard/reservations', permission: 'reservations.deposits' });
    await activity.record(kitchen, { action: 'reservation.deposit', target_type: 'reservation', target_id: r._id, summary: `Deposit RWF ${amount.toLocaleString('en-US')} for ${r.name}`, details: { amount_rwf: amount, method } });
    return serialize(await Reservation.findById(r._id).lean());
  }

  /** "Manage table availability": which tables are free for a party at a time. */
  async availability(kitchen, query = {}) {
    anyOf(kitchen, ['reservations.table_availability', 'reservations.assign_tables', 'reservations.view']);
    const { rules } = await this.settings(kitchen.vendorId);
    const startsAt = query.at ? parseWhen(query.at, 'at') : new Date();
    const duration = Number(query.duration_minutes || rules.duration_minutes);
    const tables = await this.#freeTables(kitchen.vendorId, startsAt, duration, Number(query.party_size || 1), rules.buffer_minutes);
    return { at: startsAt, tables };
  }

  async #freeTables(vendorId, startsAt, duration, party, bufferMinutes) {
    const endsAt = new Date(startsAt.getTime() + duration * 60000);
    const buffer = bufferMinutes * 60000;
    const [tables, bookings, live] = await Promise.all([
      DiningTable.find({ vendor_id: vendorId, deleted_at: null }).lean(),
      Reservation.find({ vendor_id: vendorId, status: { $in: HOLDS_TABLE }, table_id: { $ne: null }, starts_at: { $lt: new Date(endsAt.getTime() + buffer) }, ends_at: { $gt: new Date(startsAt.getTime() - buffer) } }).lean(),
      // Guests at the table now keep it busy for a booking in the next hour.
      startsAt.getTime() - Date.now() < 3600000 ? TableSession.find({ vendor_id: vendorId, status: 'active' }).select('table_id').lean() : [],
    ]);
    const busy = new Map(bookings.map((b) => [String(b.table_id), b]));
    const occupied = new Set(live.map((s) => String(s.table_id)));
    return tables
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      .map((t) => ({
        id: String(t._id),
        label: t.label,
        capacity: t.capacity ?? null,
        is_active: t.is_active !== false,
        fits: !t.capacity || t.capacity >= party,
        booked_by: busy.get(String(t._id))?.name || null,
        occupied: occupied.has(String(t._id)),
        free: t.is_active !== false && !busy.has(String(t._id)) && !occupied.has(String(t._id)) && (!t.capacity || t.capacity >= party),
      }));
  }

  /** "View active dining sessions": tables with guests, an open bill or open orders. */
  async sessions(kitchen) {
    anyOf(kitchen, ['reservations.active_sessions', 'tables.sessions_view', 'reservations.manage_sessions']);
    const [bills, seated, open, live] = await Promise.all([
      Invoice.find({ vendor_id: kitchen.vendorId, kind: 'table', is_open: true }).lean(),
      Reservation.find({ vendor_id: kitchen.vendorId, status: 'seated' }).lean(),
      Order.aggregate([
        { $match: { vendor_id: mongoose.Types.ObjectId.createFromHexString(kitchen.vendorId), 'table.table_id': { $ne: null }, status: { $nin: ['delivered', 'cancelled'] } } },
        { $group: { _id: '$table.table_id', orders: { $sum: 1 }, since: { $min: '$created_at' } } },
      ]),
      TableSession.find({ vendor_id: kitchen.vendorId, status: 'active' }).lean(),
    ]);
    const tables = await DiningTable.find({ vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    const byTable = new Map(tables.map((t) => [String(t._id), { table: { id: String(t._id), label: t.label }, session_id: null, guest_count: null, server: null, bill: null, reservation: null, open_orders: 0, since: null }]));
    for (const s of live) {
      const row = byTable.get(String(s.table_id));
      if (row) Object.assign(row, { session_id: String(s._id), guest_count: s.guest_count, server: s.server_id ? { id: String(s.server_id), name: s.server_name } : null, since: s.started_at });
    }
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
    return { sessions: [...byTable.values()].filter((r) => r.session_id || r.bill || r.reservation || r.open_orders) };
  }

  // --- online booking (the kitchen's public page) -------------------------

  async #publicVendor(vendorId) {
    const id = parseObjectId(vendorId, 'vendor_id');
    const { vendor, rules } = await this.settings(id);
    if (!vendor || vendor.deleted_at || vendor.verification_status !== 'approved') throw ApiError.notFound('Kitchen not found.', 'VENDOR_NOT_FOUND');
    const tables = await DiningTable.countDocuments({ vendor_id: id, deleted_at: null, is_active: true });
    if (!rules.enabled_online || !tables) throw ApiError.conflict(`${vendor.name} doesn't take table bookings online.`, 'RESERVATIONS_OFF');
    return { vendor, rules };
  }

  /** Opening hours for a Kigali day, as [open, close] minutes after midnight (null: closed). */
  #hoursFor(vendor, dayStartUtc) {
    const dayName = DAYS[new Date(dayStartUtc.getTime() + KIGALI_OFFSET).getUTCDay()];
    const entry = (vendor.operating_hours || []).find((h) => String(h.day).toLowerCase() === dayName);
    if (!entry) return [11 * 60, 22 * 60];
    if (entry.is_closed || !entry.open_time || !entry.close_time) return null;
    const toMin = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1] || 0);
    const open = toMin(entry.open_time);
    let close = toMin(entry.close_time);
    if (close <= open) close += 24 * 60;
    return [open, close];
  }

  /** Free times on a day for a party (every 30 minutes, ending before closing). */
  async publicSlots(vendorId, query = {}) {
    const { vendor, rules } = await this.#publicVendor(vendorId);
    const party = parseParty(query.party_size || 2, rules.max_party);
    const date = String(query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('Pick a day.', { date: 'expected YYYY-MM-DD' });
    const dayStart = new Date(new Date(`${date}T00:00:00Z`).getTime() - KIGALI_OFFSET);
    if (Number.isNaN(dayStart.getTime()) || dayStart.getTime() > Date.now() + 90 * 86400000) throw ApiError.badRequest('Bookings open up to 90 days ahead.', { date: 'too far ahead' });
    const hours = this.#hoursFor(vendor, dayStart);
    const slots = [];
    if (hours) {
      for (let m = hours[0]; m + rules.duration_minutes <= hours[1]; m += 30) {
        const at = new Date(dayStart.getTime() + m * 60000);
        if (at.getTime() < Date.now() + 30 * 60000) continue;
        const free = (await this.#freeTables(vendor._id, at, rules.duration_minutes, party, rules.buffer_minutes)).filter((t) => t.free);
        slots.push({ starts_at: at, available: free.length > 0 });
      }
    }
    return {
      date,
      party_size: party,
      open: Boolean(hours),
      slots,
      rules: { duration_minutes: rules.duration_minutes, max_party: rules.max_party, deposit_rwf: (rules.deposit_per_guest_rwf || 0) * party, refund_deposit_hours: rules.refund_deposit_hours, requires_confirmation: rules.require_confirmation, preorders: rules.preorders },
    };
  }

  /**
   * A guest books online. Checked against the kitchen's rules and real free
   * tables (buffer included); held as "pending" when the kitchen confirms
   * bookings itself. The guest gets a private link (token) to view or cancel it.
   */
  async publicCreate(vendorId, body = {}, customer = null) {
    const { vendor, rules } = await this.#publicVendor(vendorId);
    const startsAt = parseWhen(body.starts_at);
    if (startsAt.getTime() < Date.now() + 30 * 60000) throw ApiError.badRequest('Book at least 30 minutes ahead.', { starts_at: 'too soon' });
    if (startsAt.getTime() > Date.now() + 90 * 86400000) throw ApiError.badRequest('Bookings open up to 90 days ahead.', { starts_at: 'too far ahead' });
    const party = parseParty(body.party_size, rules.max_party);
    const name = parseRequiredText(body.name ?? customer?.name, { field: 'name', min: 2, max: 80 });
    const phone = parseRequiredText(body.phone ?? customer?.phone, { field: 'phone', min: 9, max: 20 }).replace(/\s+/g, '');
    if (!/^\+?\d{9,15}$/.test(phone)) throw ApiError.badRequest('Enter a valid phone number.', { phone: 'expected digits' });
    const dayStart = new Date(Math.floor((startsAt.getTime() + KIGALI_OFFSET) / 86400000) * 86400000 - KIGALI_OFFSET);
    const hours = this.#hoursFor(vendor, dayStart);
    const minute = (startsAt.getTime() - dayStart.getTime()) / 60000;
    if (!hours || minute < hours[0] || minute + rules.duration_minutes > hours[1]) throw ApiError.conflict(`${vendor.name} is closed at that time.`, 'KITCHEN_CLOSED_THEN');
    // No flood of bookings from one number.
    const pendingFromPhone = await Reservation.countDocuments({ vendor_id: vendor._id, phone, status: { $in: UPCOMING }, starts_at: { $gt: new Date() } });
    if (pendingFromPhone >= 3) throw ApiError.tooMany('You already have 3 upcoming bookings here.', 'TOO_MANY_BOOKINGS');
    const free = (await this.#freeTables(vendor._id, startsAt, rules.duration_minutes, party, rules.buffer_minutes)).filter((t) => t.free);
    if (!free.length) throw ApiError.conflict('No table is free for your party at that time. Try another time.', 'NO_TABLE_FREE');
    const preorder = rules.preorders ? await this.#preorder(vendor._id, body.preorder_items) : [];
    // Without manual confirmation, the smallest table that fits is held now.
    const table = rules.require_confirmation ? null : free.sort((a, b) => (a.capacity || 99) - (b.capacity || 99))[0];
    const token = crypto.randomBytes(24).toString('base64url');
    const required = (rules.deposit_per_guest_rwf || 0) * party;
    const r = await Reservation.create({
      vendor_id: vendor._id,
      name,
      phone,
      email: parseOptionalText(body.email, { field: 'email', max: 120 }) || '',
      party_size: party,
      starts_at: startsAt,
      duration_minutes: rules.duration_minutes,
      ends_at: new Date(startsAt.getTime() + rules.duration_minutes * 60000),
      table_id: table ? table.id : null,
      table_label: table ? table.label : '',
      status: rules.require_confirmation ? 'pending' : 'confirmed',
      confirmed_at: rules.require_confirmation ? null : new Date(),
      source: 'online',
      customer_id: customer?._id || null,
      token_hash: hashToken(token),
      special_requests: parseOptionalText(body.special_requests, { field: 'special_requests', max: 300 }) || '',
      dietary_notes: parseOptionalText(body.dietary_notes, { field: 'dietary_notes', max: 300 }) || '',
      preorder_items: preorder,
      deposit: { required_rwf: required, status: required > 0 ? 'required' : 'none' },
      history: [{ status: rules.require_confirmation ? 'pending' : 'confirmed', at: new Date(), by: name, note: 'Booked online' }],
      created_by: { type: customer ? 'customer' : 'guest', id: customer ? String(customer._id) : null, name },
    });
    alerts.emit(vendor._id, 'reservations', {
      title: `${rules.require_confirmation ? 'Booking to confirm' : 'New online booking'}: ${name} (${party})`,
      body: kigaliTime(startsAt),
      link: '/vendor-dashboard/reservations',
      permission: rules.require_confirmation ? 'reservations.confirm' : 'reservations.view',
    });
    activity.recordSystem(vendor._id, { action: 'reservation.online', target_type: 'reservation', target_id: r._id, summary: `${name} booked online for ${party}` }, { type: 'guest', id: null, name });
    return { ...serialize(r.toObject(), { publicView: true }), kitchen: { id: String(vendor._id), name: vendor.name }, token };
  }

  async #byToken(token) {
    if (!token || String(token).length < 20) throw ApiError.notFound('Booking not found.', 'RESERVATION_NOT_FOUND');
    const r = await Reservation.findOne({ token_hash: hashToken(token) }).lean();
    if (!r) throw ApiError.notFound('Booking not found.', 'RESERVATION_NOT_FOUND');
    return r;
  }

  async publicGet(token) {
    const r = await this.#byToken(token);
    const vendor = await Vendor.findById(r.vendor_id).select('name address phone').lean();
    const { rules } = await this.settings(r.vendor_id);
    return { ...serialize(r, { publicView: true }), kitchen: { id: String(r.vendor_id), name: vendor?.name || '', address: vendor?.address || '', phone: vendor?.phone || '' }, refund_deposit_hours: rules.refund_deposit_hours, can_cancel: UPCOMING.includes(r.status) };
  }

  async publicCancel(token) {
    const r = await this.#byToken(token);
    if (!UPCOMING.includes(r.status)) throw ApiError.conflict('This booking can no longer be cancelled online.', 'RESERVATION_FINISHED');
    const { rules } = await this.settings(r.vendor_id);
    const set = { status: 'cancelled', cancelled_at: new Date(), ...this.#depositOnCancel(r, rules, {}, null) };
    const saved = await Reservation.findOneAndUpdate({ _id: r._id, status: r.status }, { $set: set, $push: { history: { status: 'cancelled', at: new Date(), by: r.name, note: 'Cancelled by the guest' } } }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.conflict('This booking just changed. Refresh and try again.', 'RESERVATION_CHANGED');
    alerts.emit(r.vendor_id, 'reservations', { title: `${r.name} cancelled their booking`, body: kigaliTime(r.starts_at), link: '/vendor-dashboard/reservations', permission: 'reservations.view' });
    return this.publicGet(token);
  }

  /** The signed-in customer's bookings, any kitchen. */
  async mine(customerId) {
    const rows = await Reservation.find({ customer_id: customerId }).sort({ starts_at: -1 }).limit(50).lean();
    const vendors = await Vendor.find({ _id: { $in: rows.map((r) => r.vendor_id) } }).select('name').lean();
    const names = new Map(vendors.map((v) => [String(v._id), v.name]));
    return { reservations: rows.map((r) => ({ ...serialize(r, { publicView: true }), kitchen: { id: String(r.vendor_id), name: names.get(String(r.vendor_id)) || '' } })) };
  }

  // --- reminders ------------------------------------------------------------

  /** Every few minutes: guests arriving soon (staff and the guest are reminded once). */
  async remindDue(now = new Date()) {
    const rows = await Reservation.find({ status: { $in: ['confirmed', 'booked'] }, reminder_sent_at: null, starts_at: { $gt: now, $lte: new Date(now.getTime() + 6 * 3600000) } }).limit(500).lean();
    let sent = 0;
    const rulesCache = new Map();
    for (const r of rows) {
      const key = String(r.vendor_id);
      if (!rulesCache.has(key)) rulesCache.set(key, (await this.settings(r.vendor_id)).rules);
      const rules = rulesCache.get(key);
      if (new Date(r.starts_at).getTime() - now.getTime() > rules.reminder_minutes * 60000) continue;
      const claimed = await Reservation.updateOne({ _id: r._id, reminder_sent_at: null }, { $set: { reminder_sent_at: now } });
      if (!claimed.modifiedCount) continue;
      sent += 1;
      alerts.emit(r.vendor_id, 'reservations', { title: `Arriving soon: ${r.name} (${r.party_size})`, body: `${kigaliTime(r.starts_at)}${r.table_label ? ` · ${r.table_label}` : ' · no table yet'}${r.preorder_items?.length ? ' · has a pre-order' : ''}`, link: '/vendor-dashboard/floor', permission: 'tables.seat' });
      this.#tellGuest(r, 'See you soon', `Your table for ${r.party_size} is booked for ${kigaliTime(r.starts_at)}.`);
    }
    return sent;
  }

  start(intervalMs = 5 * 60000) {
    if (this.timer) return;
    const tick = () => this.remindDue().catch((error) => console.error('[reservations] reminders failed:', error.message));
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = new ReservationService();
module.exports.NEXT = NEXT;

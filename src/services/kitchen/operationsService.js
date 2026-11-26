const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseBooleanValue } = require('../../utils/vendorValidators');
const { Vendor, Order, Invoice, DiningTable, Department, KitchenStaff } = require('../../models');
const access = require('../../config/kitchenAccess');
const activity = require('./activityService');

const OPEN_TICKET = ['pending', 'accepted', 'preparing'];
const ON_FLOOR = ['placed', 'confirmed', 'preparing', 'ready', 'assigned'];

const serializeSettings = (vendor) => {
  const ops = vendor.operations || {};
  const timing = access.PAYMENT_TIMING_IDS.includes(ops.payment_timing) ? ops.payment_timing : 'after_service';
  return {
    payment_timing: timing,
    payment_timing_label: access.PAYMENT_TIMINGS.find((t) => t.id === timing).label,
    payment_timings: access.PAYMENT_TIMINGS,
    table_ordering_enabled: ops.table_ordering_enabled !== false,
    allow_partial_service: ops.allow_partial_service !== false,
    inventory_auto_deduct: Boolean(ops.inventory_auto_deduct),
    alerts: Object.fromEntries(access.ALERT_TYPES.map((t) => [t.id, ops.alerts?.[t.id] !== false])),
    alert_types: access.ALERT_TYPES,
    loyalty: {
      enabled: Boolean(ops.loyalty?.enabled),
      earn_per_rwf: ops.loyalty?.earn_per_rwf || 1000,
      point_value_rwf: ops.loyalty?.point_value_rwf || 10,
    },
    require_packing: Boolean(ops.require_packing),
    session_close: {
      orders_complete: ops.session_close?.orders_complete !== false,
      paid: ops.session_close?.paid !== false,
      packing_resolved: ops.session_close?.packing_resolved !== false,
      requests_resolved: Boolean(ops.session_close?.requests_resolved),
    },
    reservations: { ...RESERVATION_DEFAULTS, ...Object.fromEntries(Object.entries(ops.reservations || {}).filter(([k]) => k in RESERVATION_DEFAULTS)) },
    updated_at: ops.updated_at ?? null,
  };
};

const RESERVATION_DEFAULTS = { enabled_online: true, duration_minutes: 90, buffer_minutes: 15, max_party: 12, require_confirmation: true, deposit_per_guest_rwf: 0, refund_deposit_hours: 24, keep_deposit_on_no_show: true, preorders: true, reminder_minutes: 120 };
// Whole-number reservation settings and their ranges.
const RESERVATION_NUMBERS = { duration_minutes: [15, 720], buffer_minutes: [0, 240], max_party: [1, 200], deposit_per_guest_rwf: [0, 1000000], refund_deposit_hours: [0, 720], reminder_minutes: [0, 1440] };

class OperationsService {
  async get(kitchen) {
    const vendor = await Vendor.findById(kitchen.vendorId).select('operations').lean();
    return serializeSettings(vendor || {});
  }

  /** Kitchen administrators only (route). Existing dine-in orders keep the payment rule they were placed under. */
  async update(kitchen, body = {}) {
    const set = { 'operations.updated_at': new Date() };
    const anyOf = (permissions) => {
      if (!permissions.some((p) => kitchen.can(p))) kitchen.assert(permissions[0]);
    };
    if (body.payment_timing !== undefined) anyOf(['settings.payment_preferences', 'finance.settings']);
    if (['table_ordering_enabled', 'allow_partial_service', 'inventory_auto_deduct'].some((f) => body[f] !== undefined)) anyOf(['settings.operational_rules']);
    if (body.payment_timing !== undefined) {
      if (!access.PAYMENT_TIMING_IDS.includes(body.payment_timing)) {
        throw ApiError.badRequest('Pick when customers pay.', { payment_timing: `expected one of: ${access.PAYMENT_TIMING_IDS.join(', ')}` });
      }
      set['operations.payment_timing'] = body.payment_timing;
    }
    if (body.alerts && typeof body.alerts === 'object') {
      for (const type of access.ALERT_TYPES) {
        if (body.alerts[type.id] === undefined) continue;
        if (!kitchen.can(type.setting) && !kitchen.can('settings.notifications')) kitchen.assert(type.setting);
        set[`operations.alerts.${type.id}`] = parseBooleanValue(body.alerts[type.id], { field: `alerts.${type.id}` });
      }
    }
    if (body.loyalty && typeof body.loyalty === 'object') {
      anyOf(['customers.loyalty', 'settings.operational_rules']);
      if (body.loyalty.enabled !== undefined) set['operations.loyalty.enabled'] = parseBooleanValue(body.loyalty.enabled, { field: 'loyalty.enabled' });
      for (const [field, min] of [['earn_per_rwf', 100], ['point_value_rwf', 1]]) {
        if (body.loyalty[field] === undefined) continue;
        const n = Number(body.loyalty[field]);
        if (!Number.isInteger(n) || n < min || n > 1000000) throw ApiError.badRequest(`loyalty.${field} must be a whole number of at least ${min}.`, { [`loyalty.${field}`]: 'out of range' });
        set[`operations.loyalty.${field}`] = n;
      }
    }
    for (const field of ['table_ordering_enabled', 'allow_partial_service', 'inventory_auto_deduct', 'require_packing']) {
      if (body[field] !== undefined) {
        anyOf(['settings.operational_rules']);
        set[`operations.${field}`] = parseBooleanValue(body[field], { field });
      }
    }
    if (body.session_close && typeof body.session_close === 'object') {
      anyOf(['settings.operational_rules']);
      for (const field of ['orders_complete', 'paid', 'packing_resolved', 'requests_resolved']) {
        if (body.session_close[field] !== undefined) set[`operations.session_close.${field}`] = parseBooleanValue(body.session_close[field], { field: `session_close.${field}` });
      }
    }
    if (body.reservations && typeof body.reservations === 'object') {
      anyOf(['settings.operational_rules', 'reservations.edit']);
      for (const field of ['enabled_online', 'require_confirmation', 'keep_deposit_on_no_show', 'preorders']) {
        if (body.reservations[field] !== undefined) set[`operations.reservations.${field}`] = parseBooleanValue(body.reservations[field], { field: `reservations.${field}` });
      }
      for (const [field, [min, max]] of Object.entries(RESERVATION_NUMBERS)) {
        if (body.reservations[field] === undefined) continue;
        if (field === 'deposit_per_guest_rwf') anyOf(['reservations.deposits', 'finance.settings']);
        const n = Number(body.reservations[field]);
        if (!Number.isInteger(n) || n < min || n > max) throw ApiError.badRequest(`reservations.${field} must be a whole number from ${min} to ${max}.`, { [`reservations.${field}`]: 'out of range' });
        set[`operations.reservations.${field}`] = n;
      }
    }
    const vendor = await Vendor.findOneAndUpdate({ _id: kitchen.vendorId }, { $set: set }, { returnDocument: 'after' }).select('operations').lean();
    await activity.record(kitchen, { action: 'operations.updated', target_type: 'kitchen', target_id: kitchen.vendorId, summary: 'Changed the kitchen operations settings', details: set });
    return serializeSettings(vendor);
  }

  /**
   * GET /vendor/workspace — who is signed in, what they may do, and the
   * counts behind their badges (their queue, the counter, open bills).
   * The dashboard polls it, so staff hear about new tickets and ready items.
   */
  async workspace(kitchen) {
    const vendorId = kitchen.vendorId;
    const prepScope = kitchen.scope('kitchen.view_queue');
    const [departments, queueCount, waitingCount, openBills, tables, staffCount] = await Promise.all([
      Department.find({ vendor_id: vendorId, deleted_at: null }).sort({ sort_order: 1 }).select('name is_active category code_prefix').lean(),
      prepScope !== null && !prepScope.length
        ? 0
        : Order.aggregate([
            { $match: { vendor_id: new mongoose.Types.ObjectId(vendorId), status: { $in: ON_FLOOR } } },
            { $unwind: '$tickets' },
            { $match: { 'tickets.status': { $in: OPEN_TICKET }, ...(prepScope !== null ? { 'tickets.department_id': { $in: prepScope.map((id) => new mongoose.Types.ObjectId(id)) } } : {}) } },
            { $count: 'n' },
          ]).then((r) => r[0]?.n || 0),
      kitchen.can('service.view_ready') ? Order.countDocuments({ vendor_id: vendorId, status: { $in: ON_FLOOR }, 'items.service_status': 'waiting_collection' }) : 0,
      kitchen.can('invoices.view') || kitchen.can('invoices.outstanding') ? Invoice.countDocuments({ vendor_id: vendorId, status: { $in: ['unpaid', 'partially_paid'] } }) : 0,
      kitchen.can('tables.view') || kitchen.can('overview.active_tables') ? DiningTable.countDocuments({ vendor_id: vendorId, deleted_at: null }) : 0,
      kitchen.can('staff.view') || kitchen.can('overview.active_employees') ? KitchenStaff.countDocuments({ vendor_id: vendorId, deleted_at: null }) : 0,
    ]);
    const { TableSession, PackingTask, Reservation, WaitlistEntry } = require('../../models');
    const [requests, inboxUnread, clock, liveTables, toPack, toConfirm, waiting, myTables, myDeliveries] = await Promise.all([
      kitchen.can('service.customer_requests') ? require('./serviceRequestService').openCount(vendorId) : 0,
      require('./alertService').inbox.unreadCount(kitchen),
      require('./teamService').myStatus(kitchen),
      kitchen.can('tables.seat') || kitchen.can('tables.sessions_view') ? TableSession.countDocuments({ vendor_id: vendorId, is_live: true }) : 0,
      kitchen.can('packing.view') ? PackingTask.countDocuments({ vendor_id: vendorId, status: 'requested' }) : 0,
      kitchen.can('reservations.confirm') ? Reservation.countDocuments({ vendor_id: vendorId, status: 'pending', starts_at: { $gt: new Date() } }) : 0,
      kitchen.can('tables.waitlist') || kitchen.can('tables.seat') ? WaitlistEntry.countDocuments({ vendor_id: vendorId, status: 'waiting' }) : 0,
      kitchen.actor.type === 'staff' && kitchen.can('service.view_assigned') ? TableSession.countDocuments({ vendor_id: vendorId, is_live: true, server_id: kitchen.actor.id }) : 0,
      kitchen.actor.type === 'staff' && kitchen.can('delivery.drive') ? Order.countDocuments({ vendor_id: vendorId, 'kitchen_courier.staff_id': kitchen.actor.id, status: { $nin: ['delivered', 'cancelled'] } }) : 0,
    ]);
    return {
      ...kitchen.serialize(),
      clock,
      departments: departments.map((d) => ({ id: String(d._id), name: d.name, is_active: d.is_active !== false, category: d.category, code_prefix: d.code_prefix })),
      counts: { queue: queueCount, ready_orders: waitingCount, open_invoices: openBills, tables, staff: staffCount, requests, inbox: inboxUnread, live_tables: liveTables, to_pack: toPack, bookings_to_confirm: toConfirm, waiting_list: waiting, my_tables: myTables, my_deliveries: myDeliveries },
      settings: serializeSettings((await Vendor.findById(vendorId).select('operations').lean()) || {}),
    };
  }
}

module.exports = new OperationsService();

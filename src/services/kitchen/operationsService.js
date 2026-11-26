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
    updated_at: ops.updated_at ?? null,
  };
};

class OperationsService {
  async get(kitchen) {
    const vendor = await Vendor.findById(kitchen.vendorId).select('operations').lean();
    return serializeSettings(vendor || {});
  }

  /** Kitchen administrators only (route). Existing dine-in orders keep the payment rule they were placed under. */
  async update(kitchen, body = {}) {
    const set = { 'operations.updated_at': new Date() };
    if (body.payment_timing !== undefined) {
      if (!access.PAYMENT_TIMING_IDS.includes(body.payment_timing)) {
        throw ApiError.badRequest('Pick when customers pay.', { payment_timing: `expected one of: ${access.PAYMENT_TIMING_IDS.join(', ')}` });
      }
      set['operations.payment_timing'] = body.payment_timing;
    }
    for (const field of ['table_ordering_enabled', 'allow_partial_service', 'inventory_auto_deduct']) {
      if (body[field] !== undefined) set[`operations.${field}`] = parseBooleanValue(body[field], { field });
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
      kitchen.can('invoices.view') ? Invoice.countDocuments({ vendor_id: vendorId, status: { $in: ['unpaid', 'partially_paid'] } }) : 0,
      kitchen.can('tables.view') ? DiningTable.countDocuments({ vendor_id: vendorId, deleted_at: null }) : 0,
      kitchen.can('staff.view') ? KitchenStaff.countDocuments({ vendor_id: vendorId, deleted_at: null }) : 0,
    ]);
    return {
      ...kitchen.serialize(),
      departments: departments.map((d) => ({ id: String(d._id), name: d.name, is_active: d.is_active !== false, category: d.category, code_prefix: d.code_prefix })),
      counts: { queue: queueCount, ready_orders: waitingCount, open_invoices: openBills, tables, staff: staffCount },
      settings: serializeSettings((await Vendor.findById(vendorId).select('operations').lean()) || {}),
    };
  }
}

module.exports = new OperationsService();

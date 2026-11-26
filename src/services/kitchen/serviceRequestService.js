const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { ServiceRequest } = require('../../models');
const alerts = require('./alertService');
const activity = require('./activityService');

const KINDS = { call_waiter: 'Call the waiter', request_bill: 'Bring the bill', other: 'Something else' };

const serialize = (r) => ({
  id: String(r._id),
  table: { id: String(r.table_id), label: r.table_label },
  kind: r.kind,
  kind_label: KINDS[r.kind],
  note: r.note || '',
  status: r.status,
  handled_by: r.handled_by?.name || null,
  created_at: r.created_at,
  acknowledged_at: r.acknowledged_at,
  done_at: r.done_at,
});

/** "Manage customer requests": guests ask from their table; servers acknowledge and close them. */
class ServiceRequestService {
  /** Public: a guest asks from the table page. One open request of a kind per table at a time. */
  async create(table, body = {}) {
    const kind = String(body.kind || '');
    if (!KINDS[kind]) throw ApiError.badRequest('What do you need?', { kind: 'expected call_waiter, request_bill or other' });
    const note = parseOptionalText(body.note, { field: 'note', max: 140 }) || '';
    const existing = await ServiceRequest.findOne({ table_id: table._id, kind, status: { $ne: 'done' } }).lean();
    if (existing) return { request: serialize(existing), already_open: true };
    const request = await ServiceRequest.create({ vendor_id: table.vendor_id, table_id: table._id, table_label: table.label, kind, note });
    alerts.emit(table.vendor_id, 'requests', {
      title: `${table.label}: ${KINDS[kind]}`,
      body: note,
      link: '/vendor-dashboard/service',
      permission: 'service.customer_requests',
    });
    return { request: serialize(request.toObject()), already_open: false };
  }

  async openForTable(table) {
    const rows = await ServiceRequest.find({ table_id: table._id, status: { $ne: 'done' } }).sort({ created_at: 1 }).lean();
    return rows.map(serialize);
  }

  async list(kitchen, query = {}) {
    kitchen.assert('service.customer_requests');
    const filter = { vendor_id: kitchen.vendorId };
    filter.status = query.status === 'done' ? 'done' : { $ne: 'done' };
    const rows = await ServiceRequest.find(filter).sort({ created_at: query.status === 'done' ? -1 : 1 }).limit(100).lean();
    return { requests: rows.map(serialize) };
  }

  async update(kitchen, requestId, body = {}) {
    kitchen.assert('service.customer_requests');
    const id = parseObjectId(requestId, 'request_id');
    const status = String(body.status || '');
    if (!['acknowledged', 'done'].includes(status)) throw ApiError.badRequest('status is acknowledged or done.', { status: 'expected acknowledged or done' });
    const set = { status, handled_by: kitchen.actor, [`${status === 'done' ? 'done' : 'acknowledged'}_at`]: new Date() };
    const saved = await ServiceRequest.findOneAndUpdate({ _id: id, vendor_id: kitchen.vendorId }, { $set: set }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.notFound('Request not found.', 'REQUEST_NOT_FOUND');
    activity.record(kitchen, { action: `service.request_${status}`, target_type: 'table', target_id: saved.table_id, summary: `${saved.table_label}: ${KINDS[saved.kind]} → ${status}` });
    return serialize(saved);
  }

  async openCount(vendorId) {
    return ServiceRequest.countDocuments({ vendor_id: vendorId, status: 'open' });
  }
}

module.exports = new ServiceRequestService();

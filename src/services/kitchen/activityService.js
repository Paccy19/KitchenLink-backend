const { KitchenActivity } = require('../../models');
const parsePagination = require('../../utils/pagination');

/**
 * The kitchen's audit log. `record` never throws into the request: a failed
 * log write must not undo the action it describes.
 */
async function record(access, { action, target_type = '', target_id = '', summary = '', details = {}, department_id = null }) {
  try {
    const actor = access?.actor || { type: 'system', id: null, name: 'System' };
    await KitchenActivity.create({
      vendor_id: access?.vendorId,
      actor_type: actor.type,
      actor_id: actor.id,
      actor_name: actor.name,
      action,
      target_type,
      target_id: target_id ? String(target_id) : '',
      summary,
      details,
      department_id,
    });
  } catch (error) {
    console.error('[kitchen audit] could not record', action, error.message);
  }
}

/** Same, for events with no signed-in person (a guest ordering at a table). */
const recordSystem = (vendorId, entry, actor = { type: 'system', id: null, name: 'System' }) =>
  record({ vendorId: String(vendorId), actor }, entry);

async function list(access, query = {}) {
  const { limit, page, offset } = parsePagination(query, { defaultLimit: 30, maxLimit: 100 });
  const filter = { vendor_id: access.vendorId };
  // Which logs this person may read ("Audit Logs & Security").
  const all = ['audit.kitchen_logs', 'overview.activity_logs'].some((p) => access.can(p));
  if (!all) {
    const or = [];
    if (access.can('audit.employee_logs') || access.can('staff.view_activity')) or.push({ actor_type: 'staff' });
    if (access.can('audit.financial_logs')) or.push({ action: { $regex: '^(invoice|cashier|expense)\\.' } });
    if (access.can('audit.permission_changes') || access.can('roles.history')) {
      or.push({ action: { $regex: '^role\\.' } }, { action: { $in: ['staff.access_changed', 'staff.password_set', 'department.updated'] } });
    }
    if (access.can('audit.login_history')) or.push({ action: { $in: ['security.login'] } });
    if (access.can('audit.security_events')) or.push({ action: { $regex: '^security\\.' } });
    filter.$or = or.length ? or : [{ _id: null }];
  }
  if (typeof query.actor_id === 'string' && query.actor_id) filter.actor_id = query.actor_id;
  if (typeof query.action === 'string' && query.action) filter.action = { $regex: `^${query.action.replace(/[^a-z_.]/gi, '')}` };
  const [rows, total] = await Promise.all([
    KitchenActivity.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
    KitchenActivity.countDocuments(filter),
  ]);
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      summary: row.summary,
      details: row.details || {},
      created_at: row.created_at,
    })),
    meta: { page, limit, total },
  };
}

module.exports = { record, recordSystem, list };

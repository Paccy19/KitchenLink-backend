const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText, parseBooleanValue, parseOperatingHours } = require('../../utils/vendorValidators');
const { resolveImageUrl } = require('../../utils/uploads');
const { Department, KitchenStaff, MenuItem, Order } = require('../../models');
const access = require('../../config/kitchenAccess');
const activity = require('./activityService');

const CATEGORY_IDS = access.DEPARTMENT_CATEGORIES.map((c) => c.id);
const ACTIVE_TICKET = ['pending', 'accepted', 'preparing'];

const categoryLabel = (department) =>
  department.category === 'custom'
    ? department.custom_category || 'Custom service'
    : access.DEPARTMENT_CATEGORIES.find((c) => c.id === department.category)?.label || department.category;

/** Ticket stages this department uses, in order, with its own names. */
function workflowStages(department) {
  const wf = department?.workflow || {};
  const labels = { ...access.PREP_STAGE_LABELS, ...(wf.labels || {}) };
  return access.PREP_STAGES.filter(
    (stage) => (stage !== 'accepted' || wf.use_accept !== false) && (stage !== 'preparing' || wf.use_preparing !== false)
  ).map((id) => ({ id, label: labels[id] || access.PREP_STAGE_LABELS[id] }));
}

function serialize(department, extra = {}) {
  return {
    id: String(department._id),
    name: department.name,
    category: department.category,
    category_label: categoryLabel(department),
    custom_category: department.custom_category || '',
    description: department.description || '',
    image_url: department.image_url || null,
    code_prefix: department.code_prefix || 'X',
    is_active: department.is_active !== false,
    sort_order: department.sort_order ?? 0,
    manager_staff_ids: (department.manager_staff_ids || []).map(String),
    stations: department.stations || [],
    workflow: {
      use_accept: department.workflow?.use_accept !== false,
      use_preparing: department.workflow?.use_preparing !== false,
      labels: { ...access.PREP_STAGE_LABELS, ...(department.workflow?.labels || {}) },
      stages: workflowStages(department),
    },
    operating_hours: department.operating_hours || [],
    created_at: department.created_at,
    updated_at: department.updated_at,
    ...extra,
  };
}

/** What customers see of a department on the menu. */
const serializePublic = (department) => ({
  id: String(department._id),
  name: department.name,
  category: department.category,
  category_label: categoryLabel(department),
  description: department.description || '',
  image_url: department.image_url || null,
});

const parseStations = (raw) => {
  if (raw === undefined) return undefined;
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('stations must be a list.', { stations: 'expected a JSON list' });
    }
  }
  if (!Array.isArray(list) || list.length > 20) {
    throw ApiError.badRequest('Add at most 20 stations.', { stations: 'expected up to 20 stations' });
  }
  return list.map((entry, index) => {
    const name = parseRequiredText(typeof entry === 'string' ? entry : entry?.name, { field: `stations[${index}].name`, min: 1, max: 40 });
    const id = typeof entry?.id === 'string' && /^[a-z0-9-]{4,40}$/.test(entry.id) ? entry.id : crypto.randomBytes(4).toString('hex');
    return { id, name };
  });
};

function parseWorkflow(raw) {
  if (raw === undefined) return undefined;
  let wf = raw;
  if (typeof raw === 'string') {
    try {
      wf = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('workflow must be an object.', { workflow: 'expected JSON' });
    }
  }
  if (!wf || typeof wf !== 'object') throw ApiError.badRequest('workflow must be an object.', { workflow: 'expected an object' });
  const labels = {};
  for (const stage of access.PREP_STAGES) {
    const label = parseOptionalText(wf.labels?.[stage], { field: `workflow.labels.${stage}`, max: 40 });
    labels[stage] = label || access.PREP_STAGE_LABELS[stage];
  }
  return {
    use_accept: parseBooleanValue(wf.use_accept, { field: 'workflow.use_accept', fallback: true }),
    use_preparing: parseBooleanValue(wf.use_preparing, { field: 'workflow.use_preparing', fallback: true }),
    labels,
  };
}

class DepartmentService {
  async listForVendor(vendorId, { includeInactive = true } = {}) {
    const filter = { vendor_id: vendorId, deleted_at: null };
    if (!includeInactive) filter.is_active = true;
    return Department.find(filter).sort({ sort_order: 1, created_at: 1 }).lean();
  }

  /** Active departments as a map id -> department (for splitting orders into tickets). */
  async activeMap(vendorId) {
    const list = await this.listForVendor(vendorId, { includeInactive: false });
    return new Map(list.map((d) => [String(d._id), d]));
  }

  async #load(vendorId, departmentId) {
    const id = parseObjectId(departmentId, 'department_id');
    const department = await Department.findOne({ _id: id, vendor_id: vendorId, deleted_at: null }).lean();
    if (!department) throw ApiError.notFound('Department not found.', 'DEPARTMENT_NOT_FOUND');
    return department;
  }

  /** A department of this kitchen, or a 400 naming the field. Null/'' = none. */
  async resolveId(vendorId, raw, field = 'department_id') {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '' || raw === 'none') return null;
    if (!mongoose.isValidObjectId(raw)) throw ApiError.badRequest(`${field} must be a valid id.`, { [field]: 'expected a valid id' });
    const exists = await Department.exists({ _id: raw, vendor_id: vendorId, deleted_at: null });
    if (!exists) throw ApiError.badRequest('That department does not belong to this kitchen.', { [field]: 'unknown department' });
    return new mongoose.Types.ObjectId(String(raw));
  }

  async resolveIds(vendorId, raw, field = 'department_ids') {
    if (raw === undefined) return undefined;
    let list = raw;
    if (typeof raw === 'string') {
      try {
        list = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').filter(Boolean);
      } catch {
        throw ApiError.badRequest(`${field} must be a list.`, { [field]: 'expected a list of ids' });
      }
    }
    if (!Array.isArray(list)) throw ApiError.badRequest(`${field} must be a list.`, { [field]: 'expected a list of ids' });
    const unique = [...new Set(list.map(String))];
    if (unique.some((id) => !mongoose.isValidObjectId(id))) throw ApiError.badRequest(`${field} has an invalid id.`, { [field]: 'expected valid ids' });
    const count = await Department.countDocuments({ _id: { $in: unique }, vendor_id: vendorId, deleted_at: null });
    if (count !== unique.length) throw ApiError.badRequest('Some departments do not belong to this kitchen.', { [field]: 'unknown department' });
    return unique.map((id) => new mongoose.Types.ObjectId(id));
  }

  async list(kitchen) {
    const departments = await this.listForVendor(kitchen.vendorId);
    const ids = departments.map((d) => d._id);
    const [staffCounts, itemCounts, openTickets] = await Promise.all([
      KitchenStaff.aggregate([
        { $match: { vendor_id: new mongoose.Types.ObjectId(kitchen.vendorId), deleted_at: null, department_ids: { $in: ids } } },
        { $unwind: '$department_ids' },
        { $group: { _id: '$department_ids', n: { $sum: 1 } } },
      ]),
      MenuItem.aggregate([
        { $match: { vendor_id: new mongoose.Types.ObjectId(kitchen.vendorId), deleted_at: null, department_id: { $in: ids } } },
        { $group: { _id: '$department_id', n: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { vendor_id: new mongoose.Types.ObjectId(kitchen.vendorId), 'tickets.status': { $in: ACTIVE_TICKET } } },
        { $unwind: '$tickets' },
        { $match: { 'tickets.status': { $in: ACTIVE_TICKET } } },
        { $group: { _id: '$tickets.department_id', n: { $sum: 1 } } },
      ]),
    ]);
    const count = (rows) => new Map(rows.map((r) => [String(r._id), r.n]));
    const staff = count(staffCounts);
    const items = count(itemCounts);
    const tickets = count(openTickets);
    return {
      departments: departments.map((d) =>
        serialize(d, {
          staff_count: staff.get(String(d._id)) || 0,
          product_count: items.get(String(d._id)) || 0,
          open_tickets: tickets.get(String(d._id)) || 0,
        })
      ),
      categories: access.DEPARTMENT_CATEGORIES,
    };
  }

  async get(kitchen, departmentId) {
    const department = await this.#load(kitchen.vendorId, departmentId);
    const staff = await KitchenStaff.find({ vendor_id: kitchen.vendorId, deleted_at: null, department_ids: department._id })
      .select('name job_title is_active')
      .lean();
    return serialize(department, {
      staff: staff.map((s) => ({ id: String(s._id), name: s.name, job_title: s.job_title || '', is_active: s.is_active !== false })),
    });
  }

  async #parse(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 60 });
    if (!partial || body.category !== undefined) {
      const category = String(body.category || 'custom');
      if (!CATEGORY_IDS.includes(category)) {
        throw ApiError.badRequest('Pick a category from the list, or "custom".', { category: `expected one of: ${CATEGORY_IDS.join(', ')}` });
      }
      update.category = category;
    }
    if (body.custom_category !== undefined) update.custom_category = parseOptionalText(body.custom_category, { field: 'custom_category', max: 40 }) || '';
    if (body.description !== undefined) update.description = parseOptionalText(body.description, { field: 'description', max: 300 }) || '';
    if (body.code_prefix !== undefined) {
      const prefix = String(body.code_prefix || '').trim().toUpperCase();
      if (!/^[A-Z]{1,3}$/.test(prefix)) throw ApiError.badRequest('The ticket prefix is 1 to 3 letters.', { code_prefix: 'expected 1-3 letters' });
      update.code_prefix = prefix;
    }
    if (body.is_active !== undefined) update.is_active = parseBooleanValue(body.is_active, { field: 'is_active' });
    if (body.sort_order !== undefined) {
      const n = Number(body.sort_order);
      if (!Number.isInteger(n) || n < 0 || n > 999) throw ApiError.badRequest('sort_order must be 0-999.', { sort_order: 'expected 0-999' });
      update.sort_order = n;
    }
    const stations = parseStations(body.stations);
    if (stations !== undefined) update.stations = stations;
    const workflow = parseWorkflow(body.workflow);
    if (workflow !== undefined) update.workflow = workflow;
    if (body.operating_hours !== undefined) {
      update.operating_hours = body.operating_hours === null || (Array.isArray(body.operating_hours) && body.operating_hours.length === 0)
        ? []
        : parseOperatingHours(body.operating_hours);
    }
    if (body.manager_staff_ids !== undefined) {
      const ids = Array.isArray(body.manager_staff_ids) ? body.manager_staff_ids.map(String) : [];
      if (ids.some((id) => !mongoose.isValidObjectId(id))) throw ApiError.badRequest('manager_staff_ids has an invalid id.', { manager_staff_ids: 'expected valid ids' });
      const found = await KitchenStaff.countDocuments({ _id: { $in: ids }, vendor_id: kitchen.vendorId, deleted_at: null });
      if (found !== new Set(ids).size) throw ApiError.badRequest('Managers must be employees of this kitchen.', { manager_staff_ids: 'unknown employee' });
      update.manager_staff_ids = [...new Set(ids)];
    }
    const image = await resolveImageUrl({ file: body.__file, image_url: body.image_url, image_base64: body.image_base64 });
    if (image !== undefined) update.image_url = image;
    if (body.image_clear === true || body.image_clear === 'true') update.image_url = '';
    return update;
  }

  async create(kitchen, body = {}, file) {
    const update = await this.#parse(kitchen, { ...body, __file: file }, { partial: false });
    if (update.manager_staff_ids?.length && !kitchen.isAdmin) {
      throw ApiError.forbidden('Only a kitchen administrator can choose department managers.', 'KITCHEN_ADMIN_ONLY');
    }
    if (!update.code_prefix) {
      update.code_prefix = access.DEPARTMENT_CATEGORIES.find((c) => c.id === update.category)?.prefix || update.name[0].toUpperCase();
    }
    const count = await Department.countDocuments({ vendor_id: kitchen.vendorId, deleted_at: null });
    if (count >= 30) throw ApiError.conflict('A kitchen can have at most 30 departments.', 'DEPARTMENT_LIMIT');
    if (update.sort_order === undefined) update.sort_order = count;
    const department = await Department.create({ ...update, vendor_id: kitchen.vendorId });
    await activity.record(kitchen, {
      action: 'department.created',
      target_type: 'department',
      target_id: department._id,
      summary: `Created the ${department.name} department`,
      department_id: department._id,
    });
    return serialize(department.toObject());
  }

  async update(kitchen, departmentId, body = {}, file) {
    const current = await this.#load(kitchen.vendorId, departmentId);
    const update = await this.#parse(kitchen, { ...body, __file: file }, { partial: true });
    // Each kind of change has its own permission, for this department.
    const id = String(current._id);
    const anyOf = (permissions) => {
      if (!permissions.some((permission) => kitchen.can(permission, id))) kitchen.assert(permissions[0], id);
    };
    // Compared in a normal form: the dashboard sends the whole form on every save.
    const norm = (field, value) => {
      if (value === undefined || value === null) return field === 'is_active' ? true : field.endsWith('_ids') || field === 'stations' || field === 'operating_hours' ? '[]' : '';
      if (field === 'workflow') {
        const labels = { ...access.PREP_STAGE_LABELS, ...(value.labels || {}) };
        return JSON.stringify([value.use_accept !== false, value.use_preparing !== false, access.PREP_STAGES.map((stage) => labels[stage])]);
      }
      if (field === 'stations') return JSON.stringify(value.map((station) => station.name));
      if (field.endsWith('_ids')) return JSON.stringify(value.map(String).sort());
      if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };
    const changed = (field) => update[field] !== undefined && norm(field, update[field]) !== norm(field, current[field]);
    if (['name', 'category', 'custom_category', 'description', 'code_prefix', 'image_url', 'sort_order'].some(changed)) anyOf(['departments.edit']);
    if (changed('is_active')) anyOf(['departments.activate', 'departments.availability']);
    if (changed('operating_hours')) anyOf(['departments.manage_hours']);
    if (changed('workflow')) anyOf(['departments.configure_workflow', 'kitchen.workflows']);
    if (changed('stations')) anyOf(['departments.settings', 'kitchen.manage_stations']);
    // Managers get extra permissions in their department: administrators only.
    if (changed('manager_staff_ids') && !kitchen.isAdmin) {
      throw ApiError.forbidden('Only a kitchen administrator can choose department managers.', 'KITCHEN_ADMIN_ONLY');
    }
    const department = await Department.findOneAndUpdate({ _id: current._id }, { $set: update }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, {
      action: 'department.updated',
      target_type: 'department',
      target_id: department._id,
      summary: `Updated the ${department.name} department`,
      details: { fields: Object.keys(update) },
      department_id: department._id,
    });
    return serialize(department);
  }

  /**
   * Removes a department. Its dishes and stock fall back to the kitchen as a
   * whole (nothing is deleted), and it is refused while tickets are still open.
   */
  async remove(kitchen, departmentId) {
    const department = await this.#load(kitchen.vendorId, departmentId);
    const open = await Order.exists({
      vendor_id: kitchen.vendorId,
      tickets: { $elemMatch: { department_id: department._id, status: { $in: ACTIVE_TICKET } } },
    });
    if (open) {
      throw ApiError.conflict('This department still has orders in preparation. Finish or cancel them first.', 'DEPARTMENT_HAS_OPEN_TICKETS');
    }
    const now = new Date();
    await Department.updateOne({ _id: department._id }, { $set: { deleted_at: now, is_active: false } });
    await Promise.all([
      MenuItem.updateMany({ vendor_id: kitchen.vendorId, department_id: department._id }, { $set: { department_id: null } }),
      KitchenStaff.updateMany({ vendor_id: kitchen.vendorId }, { $pull: { department_ids: department._id } }),
      mongoose.model('KitchenRole').updateMany({ vendor_id: kitchen.vendorId }, { $pull: { department_ids: department._id } }),
      mongoose.model('InventoryItem').updateMany({ vendor_id: kitchen.vendorId, department_id: department._id }, { $set: { department_id: null } }),
    ]);
    await activity.record(kitchen, {
      action: 'department.deleted',
      target_type: 'department',
      target_id: department._id,
      summary: `Removed the ${department.name} department`,
    });
    return { deleted: true, id: String(department._id) };
  }

  /** Puts employees in (or takes them out of) a department. */
  async setStaff(kitchen, departmentId, body = {}) {
    const department = await this.#load(kitchen.vendorId, departmentId);
    if (!kitchen.can('staff.assign_departments')) kitchen.assert('departments.manage_staff', String(department._id));
    const ids = Array.isArray(body.staff_ids) ? [...new Set(body.staff_ids.map(String))] : null;
    if (!ids || ids.some((id) => !mongoose.isValidObjectId(id))) {
      throw ApiError.badRequest('staff_ids must be a list of employee ids.', { staff_ids: 'expected a list of ids' });
    }
    const found = await KitchenStaff.countDocuments({ _id: { $in: ids }, vendor_id: kitchen.vendorId, deleted_at: null });
    if (found !== ids.length) throw ApiError.badRequest('Some employees are not part of this kitchen.', { staff_ids: 'unknown employee' });
    await KitchenStaff.updateMany(
      { vendor_id: kitchen.vendorId, _id: { $nin: ids }, department_ids: department._id },
      { $pull: { department_ids: department._id } }
    );
    await KitchenStaff.updateMany({ vendor_id: kitchen.vendorId, _id: { $in: ids } }, { $addToSet: { department_ids: department._id } });
    await activity.record(kitchen, {
      action: 'department.staff_changed',
      target_type: 'department',
      target_id: department._id,
      summary: `Set ${ids.length} employee${ids.length === 1 ? '' : 's'} in ${department.name}`,
      department_id: department._id,
    });
    return this.get(kitchen, department._id);
  }
}

module.exports = new DepartmentService();
module.exports.serialize = serialize;
module.exports.serializePublic = serializePublic;
module.exports.workflowStages = workflowStages;

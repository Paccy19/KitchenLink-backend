const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { KitchenStaff, KitchenRole, Department } = require('../../models');
const access = require('../../config/kitchenAccess');

const ALL = null; // a grant that covers the whole kitchen

/**
 * What the person behind a kitchen session may do. Built once per request
 * by requireVendorAuth and kept on `req.kitchenAccess`.
 *
 * grants: permission -> ALL (whole kitchen) or a Set of department ids.
 */
class KitchenAccess {
  constructor({ vendorId, actor, isAdmin, isOwner, grants, staff = null, departmentIds = [], managedDepartmentIds = [] }) {
    this.vendorId = String(vendorId);
    this.actor = actor;
    this.isAdmin = isAdmin;
    this.isOwner = isOwner;
    this.grants = grants;
    this.staff = staff;
    this.departmentIds = departmentIds;
    this.managedDepartmentIds = managedDepartmentIds;
  }

  /**
   * Whether the permission is held: for one department when `departmentId`
   * is given (null = an item that belongs to no department, which only a
   * kitchen-wide grant covers), or for any department when it is left out.
   */
  can(permission, departmentId) {
    if (this.isAdmin) return true;
    if (!this.grants.has(permission)) return false;
    const scope = this.grants.get(permission);
    if (scope === ALL || departmentId === undefined) return true;
    if (departmentId === null) return false;
    return scope.has(String(departmentId));
  }

  /** null = every department (and items with none); otherwise the department ids covered. */
  scope(permission) {
    if (this.isAdmin) return ALL;
    if (!this.grants.has(permission)) return [];
    const scope = this.grants.get(permission);
    return scope === ALL ? ALL : [...scope];
  }

  assert(permission, departmentId) {
    if (this.can(permission, departmentId)) return;
    const label = access.PERMISSIONS[permission]?.label || permission;
    throw ApiError.forbidden(
      departmentId !== undefined
        ? `Your role doesn't allow this for that department (${label.toLowerCase()}).`
        : `Your role doesn't allow this (${label.toLowerCase()}). Ask your kitchen administrator.`,
      'KITCHEN_PERMISSION_DENIED'
    );
  }

  /** A Mongo filter on `field` limiting to the departments this permission covers. */
  departmentFilter(permission, field = 'department_id') {
    const scope = this.scope(permission);
    if (scope === ALL) return {};
    return { [field]: { $in: scope.map((id) => new mongoose.Types.ObjectId(id)) } };
  }

  /** Like departmentFilter, over every department any of these permissions covers. */
  departmentFilterAny(permissions, field = 'department_id') {
    if (this.isAdmin) return {};
    const ids = new Set();
    for (const permission of permissions) {
      const scope = this.scope(permission);
      if (scope === ALL) return {};
      scope.forEach((id) => ids.add(id));
    }
    return { [field]: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } };
  }

  serialize() {
    const permissions = {};
    for (const key of access.PERMISSION_KEYS) {
      const scope = this.scope(key);
      if (scope === ALL) permissions[key] = 'all';
      else if (scope.length) permissions[key] = scope;
    }
    return {
      actor: this.actor,
      is_owner: this.isOwner,
      is_admin: this.isAdmin,
      department_ids: this.departmentIds,
      managed_department_ids: this.managedDepartmentIds,
      permissions,
    };
  }
}

const toIds = (list = []) => list.map((id) => String(id));

function addGrant(grants, permission, scope) {
  if (!access.PERMISSIONS[permission]) return;
  // Non-department permissions are always kitchen-wide.
  const effective = access.SCOPED.has(permission) ? scope : ALL;
  const current = grants.get(permission);
  if (current === ALL) return;
  if (effective === ALL) {
    grants.set(permission, ALL);
    return;
  }
  const merged = current ? new Set(current) : new Set();
  for (const id of effective) merged.add(id);
  grants.set(permission, merged);
}

/** The kitchen account itself: everything. */
function forOwner(vendor) {
  return new KitchenAccess({
    vendorId: vendor._id,
    actor: { type: 'owner', id: String(vendor._id), name: vendor.owner_name || vendor.name || 'Kitchen owner' },
    isAdmin: true,
    isOwner: true,
    grants: new Map(),
  });
}

async function forStaff(vendor, staff) {
  const departmentIds = toIds(staff.department_ids);
  const actor = { type: 'staff', id: String(staff._id), name: staff.name };
  if (staff.is_admin) {
    return new KitchenAccess({ vendorId: vendor._id, actor, isAdmin: true, isOwner: false, grants: new Map(), staff, departmentIds });
  }
  const [roles, managed] = await Promise.all([
    KitchenRole.find({ _id: { $in: staff.role_ids || [] }, vendor_id: vendor._id, deleted_at: null }).lean(),
    Department.find({ vendor_id: vendor._id, deleted_at: null, manager_staff_ids: staff._id }).select('_id').lean(),
  ]);
  const grants = new Map();
  for (const role of roles) {
    const roleDepartments = toIds(role.department_ids);
    const scope = roleDepartments.length ? roleDepartments : departmentIds.length ? departmentIds : ALL;
    for (const permission of role.permissions || []) {
      if (access.PERMISSIONS[permission]?.owner) continue;
      addGrant(grants, permission, scope);
    }
  }
  const managedIds = toIds(managed.map((d) => d._id));
  if (managedIds.length) {
    for (const permission of access.DEPARTMENT_MANAGER_PERMISSIONS) addGrant(grants, permission, managedIds);
  }
  return new KitchenAccess({
    vendorId: vendor._id,
    actor,
    isAdmin: false,
    isOwner: false,
    grants,
    staff,
    departmentIds,
    managedDepartmentIds: managedIds,
  });
}

/** The current staff record behind a token, or a 401 when it no longer works. */
async function loadStaffForSession(vendor, staffId) {
  if (!mongoose.isValidObjectId(staffId)) {
    throw ApiError.unauthorized('Invalid or malformed token.', 'INVALID_TOKEN');
  }
  const staff = await KitchenStaff.findOne({ _id: staffId, vendor_id: vendor._id, deleted_at: null }).lean();
  if (!staff) {
    throw ApiError.unauthorized('Your staff account was removed from this kitchen.', 'STAFF_REMOVED');
  }
  if (staff.is_active === false) {
    throw ApiError.unauthorized('Your staff account has been deactivated. Ask your kitchen administrator.', 'STAFF_DEACTIVATED');
  }
  return staff;
}

module.exports = { KitchenAccess, forOwner, forStaff, loadStaffForSession, ALL };

const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText, parseRequiredText, parseBooleanValue, parseEmail } = require('../../utils/vendorValidators');
const { normalizePhone } = require('../../utils/validators');
const crypto = require('crypto');
const { revokeAllSessions } = require('../../utils/sessions');
const { hashPassword } = require('../../utils/password');
const { parsePassword } = require('../../utils/vendorValidators');
const { KitchenStaff, KitchenRole, Vendor, Department, Customer, Driver } = require('../../models');
const access = require('../../config/kitchenAccess');
const departmentService = require('./departmentService');
const activity = require('./activityService');

const ObjectId = (id) => new mongoose.Types.ObjectId(String(id));

// ---------------------------------------------------------------- roles

const serializeRole = (role, extra = {}) => ({
  id: String(role._id),
  name: role.name,
  description: role.description || '',
  permissions: (role.permissions || []).filter((p) => access.PERMISSIONS[p]),
  department_ids: (role.department_ids || []).map(String),
  template_key: role.template_key || null,
  created_at: role.created_at,
  updated_at: role.updated_at,
  ...extra,
});

function parsePermissions(raw) {
  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('Choose the permissions for this role.', { permissions: 'expected a list of permission keys' });
  }
  const unique = [...new Set(raw.map(String))];
  const unknown = unique.filter((key) => !access.PERMISSIONS[key]);
  if (unknown.length) throw ApiError.badRequest(`Unknown permission: ${unknown[0]}.`, { permissions: `unknown: ${unknown.join(', ')}` });
  const adminOnly = unique.filter((key) => access.PERMISSIONS[key].owner);
  if (adminOnly.length) {
    throw ApiError.badRequest('Wallet and kitchen settings stay with kitchen administrators and cannot be given to a role.', {
      permissions: `administrator only: ${adminOnly.join(', ')}`,
    });
  }
  return unique;
}

class RoleService {
  /** Every kitchen starts with the default roles (created the first time roles are opened). */
  async ensureDefaults(vendorId) {
    // Once per kitchen (a flag, so roles the kitchen deleted don't come back).
    const claimed = await Vendor.findOneAndUpdate(
      { _id: vendorId, 'operations.default_roles_created': { $ne: true } },
      { $set: { 'operations.default_roles_created': true } }
    );
    if (!claimed) return;
    await KitchenRole.insertMany(
      access.DEFAULT_ROLES.map((role) => ({
        vendor_id: vendorId,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        template_key: role.key,
      }))
    );
  }

  async list(kitchen) {
    await this.ensureDefaults(kitchen.vendorId);
    const roles = await KitchenRole.find({ vendor_id: kitchen.vendorId, deleted_at: null }).sort({ created_at: 1 }).lean();
    const counts = await KitchenStaff.aggregate([
      { $match: { vendor_id: ObjectId(kitchen.vendorId), deleted_at: null } },
      { $unwind: '$role_ids' },
      { $group: { _id: '$role_ids', n: { $sum: 1 } } },
    ]);
    const byRole = new Map(counts.map((c) => [String(c._id), c.n]));
    return {
      roles: roles.map((role) => serializeRole(role, { staff_count: byRole.get(String(role._id)) || 0 })),
      catalogue: access.catalogue(),
    };
  }

  async #load(vendorId, roleId) {
    const id = parseObjectId(roleId, 'role_id');
    const role = await KitchenRole.findOne({ _id: id, vendor_id: vendorId, deleted_at: null }).lean();
    if (!role) throw ApiError.notFound('Role not found.', 'ROLE_NOT_FOUND');
    return role;
  }

  async #parse(kitchen, body, { partial }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 50 });
    if (body.description !== undefined) update.description = parseOptionalText(body.description, { field: 'description', max: 300 }) || '';
    if (!partial || body.permissions !== undefined) update.permissions = parsePermissions(body.permissions);
    if (body.department_ids !== undefined) update.department_ids = (await departmentService.resolveIds(kitchen.vendorId, body.department_ids)) || [];
    // Roles decide who may do what: only kitchen administrators shape them.
    if (!kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can create or change roles.', 'KITCHEN_ADMIN_ONLY');
    return update;
  }

  async #assertUniqueName(vendorId, name, exceptId = null) {
    const clash = await KitchenRole.findOne({
      vendor_id: vendorId,
      deleted_at: null,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    }).lean();
    if (clash) throw ApiError.conflict(`There is already a role called "${clash.name}".`, 'ROLE_NAME_TAKEN');
  }

  async create(kitchen, body = {}) {
    await this.ensureDefaults(kitchen.vendorId);
    const update = await this.#parse(kitchen, body, { partial: false });
    await this.#assertUniqueName(kitchen.vendorId, update.name);
    const role = await KitchenRole.create({ ...update, vendor_id: kitchen.vendorId });
    await activity.record(kitchen, {
      action: 'role.created',
      target_type: 'role',
      target_id: role._id,
      summary: `Created the role ${role.name}`,
      details: { permissions: role.permissions },
    });
    return serializeRole(role.toObject(), { staff_count: 0 });
  }

  async update(kitchen, roleId, body = {}) {
    const role = await this.#load(kitchen.vendorId, roleId);
    const update = await this.#parse(kitchen, body, { partial: true });
    if (update.name) await this.#assertUniqueName(kitchen.vendorId, update.name, role._id);
    // Takes effect on the employees' next request: access is worked out per request.
    const saved = await KitchenRole.findOneAndUpdate({ _id: role._id }, { $set: update }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, {
      action: 'role.updated',
      target_type: 'role',
      target_id: role._id,
      summary: `Updated the role ${saved.name}`,
      details: { before: role.permissions, after: saved.permissions },
    });
    return serializeRole(saved);
  }

  async remove(kitchen, roleId) {
    const role = await this.#load(kitchen.vendorId, roleId);
    const holders = await KitchenStaff.countDocuments({ vendor_id: kitchen.vendorId, deleted_at: null, role_ids: role._id });
    if (holders > 0) {
      throw ApiError.conflict(
        `${holders} employee${holders === 1 ? ' has' : 's have'} this role. Give them another role first.`,
        'ROLE_IN_USE'
      );
    }
    await KitchenRole.updateOne({ _id: role._id }, { $set: { deleted_at: new Date() } });
    await activity.record(kitchen, { action: 'role.deleted', target_type: 'role', target_id: role._id, summary: `Deleted the role ${role.name}` });
    return { deleted: true, id: String(role._id) };
  }
}

// ---------------------------------------------------------------- staff

function serializeStaff(staff, { roles = new Map(), departments = new Map(), managed = [] } = {}) {
  return {
    id: String(staff._id),
    name: staff.name,
    phone: staff.phone || null,
    email: staff.email || null,
    username: staff.username || null,
    has_password: Boolean(staff.password_set_at),
    job_title: staff.job_title || '',
    is_admin: Boolean(staff.is_admin),
    is_active: staff.is_active !== false,
    roles: (staff.role_ids || []).map((id) => roles.get(String(id))).filter(Boolean).map((r) => ({ id: String(r._id), name: r.name })),
    role_ids: (staff.role_ids || []).map(String),
    departments: (staff.department_ids || []).map((id) => departments.get(String(id))).filter(Boolean).map((d) => ({ id: String(d._id), name: d.name })),
    department_ids: (staff.department_ids || []).map(String),
    managed_department_ids: managed,
    last_login_at: staff.last_login_at ?? null,
    created_at: staff.created_at,
    updated_at: staff.updated_at,
  };
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
// Easy to read out loud and type: no 0/O or 1/l/I.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generatePassword = (length = 10) => Array.from({ length }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');

function parseUsername(raw) {
  const username = String(raw || '').trim().toLowerCase();
  if (!USERNAME.test(username)) {
    throw ApiError.badRequest('Usernames are 3 to 32 letters, numbers, dots, dashes or underscores, e.g. aline.barista.', {
      username: 'expected 3-32 of a-z 0-9 . _ -',
    });
  }
  return username;
}

class StaffService {
  async #context(vendorId) {
    const [roles, departments] = await Promise.all([
      KitchenRole.find({ vendor_id: vendorId, deleted_at: null }).lean(),
      Department.find({ vendor_id: vendorId, deleted_at: null }).lean(),
    ]);
    return {
      roles: new Map(roles.map((r) => [String(r._id), r])),
      departments: new Map(departments.map((d) => [String(d._id), d])),
      managers: departments,
    };
  }

  #serializeWith(staff, ctx) {
    const managed = ctx.managers.filter((d) => (d.manager_staff_ids || []).some((id) => String(id) === String(staff._id))).map((d) => String(d._id));
    return serializeStaff(staff, { ...ctx, managed });
  }

  async list(kitchen, query = {}) {
    const filter = { vendor_id: kitchen.vendorId, deleted_at: null };
    if (query.department_id && mongoose.isValidObjectId(query.department_id)) filter.department_ids = ObjectId(query.department_id);
    if (query.status === 'active') filter.is_active = true;
    if (query.status === 'inactive') filter.is_active = false;
    const [staff, ctx] = await Promise.all([KitchenStaff.find(filter).sort({ name: 1 }).lean(), this.#context(kitchen.vendorId)]);
    return { staff: staff.map((s) => this.#serializeWith(s, ctx)) };
  }

  async #load(vendorId, staffId) {
    const id = parseObjectId(staffId, 'staff_id');
    const staff = await KitchenStaff.findOne({ _id: id, vendor_id: vendorId, deleted_at: null }).lean();
    if (!staff) throw ApiError.notFound('Employee not found.', 'STAFF_NOT_FOUND');
    return staff;
  }

  async get(kitchen, staffId) {
    const staff = await this.#load(kitchen.vendorId, staffId);
    return this.#serializeWith(staff, await this.#context(kitchen.vendorId));
  }

  /**
   * Phone / email must be free: another kitchen employee, a kitchen account,
   * a customer or a delivery worker using it would make sign-in ambiguous.
   */
  async #assertIdentifierFree(field, value, exceptId) {
    if (!value) return;
    const staffClash = await KitchenStaff.exists({ [field]: value, is_current: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    const vendorClash = await Vendor.exists({ [field]: value, deleted_at: null });
    if (staffClash || vendorClash) {
      throw ApiError.conflict(
        field === 'phone'
          ? 'This phone number already signs in to a kitchen. Use another number.'
          : 'This email address already signs in to a kitchen. Use another email.',
        'STAFF_IDENTIFIER_TAKEN'
      );
    }
    if (field === 'phone') {
      const [customer, driver] = await Promise.all([Customer.exists({ phone_number: value }), Driver.exists({ phone: value, deleted_at: null })]);
      if (driver) {
        throw ApiError.conflict('This phone number belongs to a delivery worker account. Use another number.', 'STAFF_IDENTIFIER_TAKEN');
      }
      // A customer account with the same phone is fine: sign-in asks which account to open.
      void customer;
    }
  }

  async #assertUsernameFree(username, exceptId) {
    const taken = await KitchenStaff.exists({ username, is_current: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    if (taken) throw ApiError.conflict(`The username "${username}" is taken. Try another, e.g. with your kitchen's name.`, 'STAFF_USERNAME_TAKEN');
  }

  /** Splits the parsed form into what is saved and the one-time credentials to show. */
  async #withPassword(update) {
    const { password, generated, ...rest } = update;
    if (!password) return { set: rest, credentials: null };
    return {
      set: { ...rest, password_hash: await hashPassword(password), password_set_at: new Date() },
      credentials: { password, generated: Boolean(generated) },
    };
  }

  async #parse(kitchen, body, { partial, current = null }) {
    const update = {};
    if (!partial || body.name !== undefined) update.name = parseRequiredText(body.name, { field: 'name', min: 2, max: 80 });
    if (body.job_title !== undefined) update.job_title = parseOptionalText(body.job_title, { field: 'job_title', max: 60 }) || '';
    if (body.phone !== undefined) {
      update.phone = body.phone === null || body.phone === '' ? null : normalizePhone(body.phone);
    }
    if (body.email !== undefined) update.email = body.email === null || body.email === '' ? null : parseEmail(body.email);
    const phone = update.phone !== undefined ? update.phone : current?.phone;
    const email = update.email !== undefined ? update.email : current?.email;
    if (body.username !== undefined) {
      update.username = body.username === null || body.username === '' ? null : parseUsername(body.username);
      if (update.username && update.username !== current?.username) await this.#assertUsernameFree(update.username, current?._id);
    }
    const username = update.username !== undefined ? update.username : current?.username;
    // The password: typed by the administrator, made on request ("generate"),
    // or made automatically for a new username that has none yet.
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      update.password = parsePassword(body.password);
    } else if (body.generate_password === true || (username && !current?.password_set_at)) {
      update.password = generatePassword();
      update.generated = true;
    }
    if (!username && !phone && !email) {
      throw ApiError.badRequest('Give the employee a username and password, or a phone number or email to sign in with a code.', {
        username: 'a username, phone or email is required',
      });
    }
    if (update.phone !== undefined && update.phone !== current?.phone) await this.#assertIdentifierFree('phone', update.phone, current?._id);
    if (update.email !== undefined && update.email !== current?.email) await this.#assertIdentifierFree('email', update.email, current?._id);

    if (body.role_ids !== undefined) {
      // Only kitchen administrators decide who gets which role (and so which permissions).
      if (!kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can give roles to employees.', 'KITCHEN_ADMIN_ONLY');
      const ids = Array.isArray(body.role_ids) ? [...new Set(body.role_ids.map(String))] : null;
      if (!ids || ids.some((id) => !mongoose.isValidObjectId(id))) throw ApiError.badRequest('role_ids must be a list of role ids.', { role_ids: 'expected ids' });
      const roles = await KitchenRole.find({ _id: { $in: ids }, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
      if (roles.length !== ids.length) throw ApiError.badRequest('Some roles do not belong to this kitchen.', { role_ids: 'unknown role' });
      update.role_ids = ids.map(ObjectId);
    }
    if (body.department_ids !== undefined) {
      update.department_ids = (await departmentService.resolveIds(kitchen.vendorId, body.department_ids)) || [];
      const changed = JSON.stringify((current?.department_ids || []).map(String).sort()) !== JSON.stringify(update.department_ids.map(String).sort());
      if (!kitchen.isAdmin && changed && !kitchen.can('staff.assign_departments')) {
        for (const id of update.department_ids) kitchen.assert('departments.manage_staff', String(id));
      }
    }
    if (body.is_admin !== undefined) {
      const isAdmin = parseBooleanValue(body.is_admin, { field: 'is_admin' });
      if (!kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can make someone an administrator.', 'KITCHEN_ADMIN_ONLY');
      update.is_admin = isAdmin;
    }
    return update;
  }

  async create(kitchen, body = {}) {
    const update = await this.#parse(kitchen, body, { partial: false });
    const count = await KitchenStaff.countDocuments({ vendor_id: kitchen.vendorId, deleted_at: null });
    if (count >= 500) throw ApiError.conflict('This kitchen has reached the limit of 500 employees.', 'STAFF_LIMIT');
    const { set, credentials } = await this.#withPassword(update);
    let staff;
    try {
      staff = await KitchenStaff.create({ ...set, vendor_id: kitchen.vendorId });
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('This username, phone number or email already signs in to a kitchen.', 'STAFF_IDENTIFIER_TAKEN');
      throw error;
    }
    await activity.record(kitchen, {
      action: 'staff.created',
      target_type: 'staff',
      target_id: staff._id,
      summary: `Added ${staff.name} to the team`,
      details: { role_ids: (staff.role_ids || []).map(String), department_ids: (staff.department_ids || []).map(String), is_admin: staff.is_admin },
    });
    return this.#withCredentials(await this.get(kitchen, staff._id), credentials);
  }

  /** The sign-in details to hand over, shown once (only the hash is kept). */
  #withCredentials(member, credentials) {
    if (!credentials || !member.username) return member;
    return { ...member, credentials: { username: member.username, password: credentials.password, generated: credentials.generated } };
  }

  async update(kitchen, staffId, body = {}) {
    const current = await this.#load(kitchen.vendorId, staffId);
    const self = kitchen.staff && String(kitchen.staff._id) === String(current._id);
    if (self && (body.is_admin !== undefined || body.role_ids !== undefined)) {
      throw ApiError.forbidden("You can't change your own roles or administrator access. Ask another administrator.", 'STAFF_SELF_CHANGE');
    }
    if (current.is_admin && !kitchen.isAdmin) {
      throw ApiError.forbidden('Only a kitchen administrator can change another administrator.', 'KITCHEN_ADMIN_ONLY');
    }
    const parsed = await this.#parse(kitchen, body, { partial: true, current });
    if (parsed.password && !kitchen.can('staff.reset_passwords')) kitchen.assert('staff.edit');
    const identity = ['name', 'job_title', 'phone', 'email', 'username'].filter((field) => parsed[field] !== undefined && parsed[field] !== current[field]);
    if (identity.length) kitchen.assert('staff.edit');
    const { set: update, credentials } = await this.#withPassword(parsed);
    let saved;
    try {
      saved = await KitchenStaff.findOneAndUpdate({ _id: current._id }, { $set: update }, { returnDocument: 'after' }).lean();
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('This username, phone number or email already signs in to a kitchen.', 'STAFF_IDENTIFIER_TAKEN');
      throw error;
    }
    // New sign-in details (password, username, phone, email): sessions opened with the old ones end.
    if (
      credentials ||
      (update.username !== undefined && update.username !== current.username) ||
      (update.phone !== undefined && update.phone !== current.phone) ||
      (update.email !== undefined && update.email !== current.email)
    ) {
      await revokeAllSessions(KitchenStaff, current._id);
    }
    await activity.record(kitchen, {
      action: credentials ? 'staff.password_set' : update.role_ids || update.is_admin !== undefined ? 'staff.access_changed' : 'staff.updated',
      target_type: 'staff',
      target_id: current._id,
      summary: `Updated ${saved.name}`,
      details: {
        fields: Object.keys(update).filter((key) => key !== 'password_hash'),
        ...(update.role_ids ? { roles_before: (current.role_ids || []).map(String), roles_after: update.role_ids.map(String) } : {}),
        ...(update.is_admin !== undefined ? { is_admin: update.is_admin } : {}),
      },
    });
    return this.#withCredentials(await this.get(kitchen, current._id), credentials);
  }

  /** Deactivating signs the employee out at once (every request checks the account). */
  async setActive(kitchen, staffId, body = {}) {
    const current = await this.#load(kitchen.vendorId, staffId);
    const active = parseBooleanValue(body.is_active, { field: 'is_active' });
    if (active === undefined) throw ApiError.badRequest('is_active is required.', { is_active: 'expected true or false' });
    if (kitchen.staff && String(kitchen.staff._id) === String(current._id)) {
      throw ApiError.forbidden("You can't deactivate your own account.", 'STAFF_SELF_CHANGE');
    }
    if (current.is_admin && !kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can deactivate an administrator.', 'KITCHEN_ADMIN_ONLY');
    await KitchenStaff.updateOne({ _id: current._id }, { $set: { is_active: active } });
    if (!active) await revokeAllSessions(KitchenStaff, current._id);
    await activity.record(kitchen, {
      action: active ? 'staff.activated' : 'staff.deactivated',
      target_type: 'staff',
      target_id: current._id,
      summary: `${active ? 'Reactivated' : 'Deactivated'} ${current.name}`,
    });
    return this.get(kitchen, current._id);
  }

  /** Ends every session of the employee at once (they sign in again). */
  async signOutEverywhere(kitchen, staffId) {
    const current = await this.#load(kitchen.vendorId, staffId);
    if (current.is_admin && !kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can sign out an administrator.', 'KITCHEN_ADMIN_ONLY');
    await revokeAllSessions(KitchenStaff, current._id);
    await activity.record(kitchen, { action: 'security.sessions_revoked', target_type: 'staff', target_id: current._id, summary: `Signed ${current.name} out of every device` });
    return { signed_out: true, id: String(current._id) };
  }

  async remove(kitchen, staffId) {
    const current = await this.#load(kitchen.vendorId, staffId);
    if (kitchen.staff && String(kitchen.staff._id) === String(current._id)) {
      throw ApiError.forbidden("You can't remove your own account.", 'STAFF_SELF_CHANGE');
    }
    if (current.is_admin && !kitchen.isAdmin) throw ApiError.forbidden('Only a kitchen administrator can remove an administrator.', 'KITCHEN_ADMIN_ONLY');
    await KitchenStaff.updateOne({ _id: current._id }, { $set: { deleted_at: new Date(), is_current: false, is_active: false } });
    await Department.updateMany({ vendor_id: kitchen.vendorId }, { $pull: { manager_staff_ids: current._id } });
    await revokeAllSessions(KitchenStaff, current._id);
    await activity.record(kitchen, { action: 'staff.removed', target_type: 'staff', target_id: current._id, summary: `Removed ${current.name} from the team` });
    return { deleted: true, id: String(current._id) };
  }
}

module.exports = { roleService: new RoleService(), staffService: new StaffService(), serializeStaff, serializeRole };

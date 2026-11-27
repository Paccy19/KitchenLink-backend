const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const parsePagination = require('../../utils/pagination');
const { parseObjectId, parseOptionalText, parseRequiredText } = require('../../utils/vendorValidators');
const { StaffNotification, Vendor, KitchenStaff } = require('../../models');
const access = require('../../config/kitchenAccess');

/**
 * Kitchen alerts and the team inbox. `emit` never throws into the request
 * that caused it: a failed alert must not undo an order.
 */
const quietly = (promise) => Promise.resolve(promise).catch((error) => console.error('[kitchen alerts]', error.message));

async function alertsOn(vendorId, type) {
  const vendor = await Vendor.findById(vendorId).select('operations.alerts').lean();
  return vendor?.operations?.alerts?.[type] !== false;
}

/** An automatic alert for whoever holds `permission` (and the administrators, unless `admins: false`). */
function emit(vendorId, type, { title, body = '', link = '', permission = null, admins = true }) {
  return quietly(
    (async () => {
      if (!(await alertsOn(vendorId, type))) return;
      await StaffNotification.create({
        vendor_id: vendorId,
        kind: 'alert',
        alert_type: type,
        title,
        body,
        link,
        recipients: { permission, admins },
      });
    })()
  );
}

/** An alert for one employee (an order given to them, a delivery to make). */
function toStaff(vendorId, staffId, { title, body = '', link = '', type = 'order_alerts' }) {
  return quietly(
    StaffNotification.create({ vendor_id: vendorId, kind: 'alert', alert_type: type, title, body, link, recipients: { staff_ids: [String(staffId)] } })
  );
}

const meKey = (kitchen) => (kitchen.actor.type === 'staff' ? kitchen.actor.id : 'owner');

/** What reaches this person: addressed to them, their roles, departments or permissions. */
function audienceFilter(kitchen) {
  const or = [{ 'recipients.all': true }];
  if (kitchen.isAdmin) or.push({ 'recipients.admins': true });
  if (kitchen.staff) {
    or.push({ 'recipients.staff_ids': String(kitchen.staff._id) });
    const roles = (kitchen.staff.role_ids || []).map(String);
    const departments = (kitchen.staff.department_ids || []).map(String);
    if (roles.length) or.push({ 'recipients.role_ids': { $in: roles } });
    if (departments.length) or.push({ 'recipients.department_ids': { $in: departments } });
  }
  const held = kitchen.isAdmin ? null : access.PERMISSION_KEYS.filter((key) => kitchen.can(key));
  or.push(held === null ? { 'recipients.permission': { $ne: null } } : { 'recipients.permission': { $in: held } });
  return { vendor_id: kitchen.vendorId, $or: or };
}

const serialize = (n, me) => ({
  id: String(n._id),
  kind: n.kind,
  alert_type: n.alert_type,
  title: n.title,
  body: n.body,
  link: n.link || null,
  from: n.created_by?.name || (n.kind === 'alert' ? 'KitchenLink' : ''),
  read: (n.read_by || []).includes(me),
  created_at: n.created_at,
});

class InboxService {
  async muted(kitchen) {
    if (!kitchen.staff) return [];
    const staff = await KitchenStaff.findById(kitchen.staff._id).select('notification_prefs').lean();
    return staff?.notification_prefs?.muted || [];
  }

  async list(kitchen, query = {}) {
    const { limit, page, offset } = parsePagination(query, { defaultLimit: 30, maxLimit: 100 });
    const filter = audienceFilter(kitchen);
    const muted = await this.muted(kitchen);
    if (muted.length) filter.alert_type = { $nin: muted };
    if (query.kind === 'message' || query.kind === 'alert') filter.kind = query.kind;
    const me = meKey(kitchen);
    const [rows, total, unread] = await Promise.all([
      StaffNotification.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      StaffNotification.countDocuments(filter),
      StaffNotification.countDocuments({ ...filter, read_by: { $ne: me } }),
    ]);
    return { items: rows.map((n) => serialize(n, me)), unread_count: unread, meta: { page, limit, total } };
  }

  async unreadCount(kitchen) {
    const filter = audienceFilter(kitchen);
    const muted = await this.muted(kitchen);
    if (muted.length) filter.alert_type = { $nin: muted };
    return StaffNotification.countDocuments({ ...filter, read_by: { $ne: meKey(kitchen) } });
  }

  async markRead(kitchen, id) {
    const nid = parseObjectId(id, 'notification_id');
    await StaffNotification.updateOne({ _id: nid, ...audienceFilter(kitchen) }, { $addToSet: { read_by: meKey(kitchen) } });
    return { read: true };
  }

  async markAllRead(kitchen) {
    await StaffNotification.updateMany({ ...audienceFilter(kitchen), read_by: { $ne: meKey(kitchen) } }, { $addToSet: { read_by: meKey(kitchen) } });
    return { read: true };
  }

  /** "Send internal notifications": a message to everyone, or to people, roles or departments. */
  async send(kitchen, body = {}) {
    kitchen.assert('notifications.internal');
    const title = parseRequiredText(body.title, { field: 'title', min: 2, max: 100 });
    const text = parseOptionalText(body.body, { field: 'body', max: 1000 }) || '';
    const to = body.to || {};
    const ids = (list, field) => {
      const values = Array.isArray(list) ? [...new Set(list.map(String))] : [];
      if (values.some((v) => !mongoose.isValidObjectId(v))) throw ApiError.badRequest(`${field} has an invalid id.`, { [field]: 'expected ids' });
      return values;
    };
    const recipients = {
      all: to.all === true,
      staff_ids: ids(to.staff_ids, 'to.staff_ids'),
      role_ids: ids(to.role_ids, 'to.role_ids'),
      department_ids: ids(to.department_ids, 'to.department_ids'),
      admins: to.admins === true,
    };
    if (!recipients.all && !recipients.admins && !recipients.staff_ids.length && !recipients.role_ids.length && !recipients.department_ids.length) {
      throw ApiError.badRequest('Choose who receives the message.', { to: 'everyone, people, roles or departments' });
    }
    const n = await StaffNotification.create({ vendor_id: kitchen.vendorId, kind: 'message', title, body: text, recipients, created_by: kitchen.actor, read_by: [meKey(kitchen)] });
    require('./activityService').record(kitchen, { action: 'notification.sent', target_type: 'notification', target_id: n._id, summary: `Sent "${title}" to the team` });
    return serialize(n.toObject(), meKey(kitchen));
  }

  /** "Manage notification preferences": the alert kinds this person doesn't want. */
  async getPreferences(kitchen) {
    return { muted: await this.muted(kitchen), alert_types: access.ALERT_TYPES };
  }

  async setPreferences(kitchen, body = {}) {
    if (!kitchen.staff) throw ApiError.badRequest('The kitchen account sets the kitchen alerts in Operations settings.', { muted: 'staff only' });
    kitchen.assert('notifications.preferences');
    const allowed = access.ALERT_TYPES.map((t) => t.id);
    const muted = Array.isArray(body.muted) ? [...new Set(body.muted.map(String))].filter((t) => allowed.includes(t)) : [];
    await KitchenStaff.updateOne({ _id: kitchen.staff._id }, { $set: { 'notification_prefs.muted': muted } });
    return this.getPreferences(kitchen);
  }
}

module.exports = { emit, toStaff, inbox: new InboxService() };

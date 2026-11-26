const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { parseObjectId, parseOptionalText } = require('../../utils/vendorValidators');
const { sendSms } = require('../../utils/sms');
const { sendEmail, escapeHtml } = require('../../utils/email');
const config = require('../../config');
const { KitchenStaff, StaffShift, StaffAttendance, Vendor } = require('../../models');
const departmentService = require('./departmentService');
const alerts = require('./alertService');
const activity = require('./activityService');

const { ObjectId } = mongoose.Types;
const LATE_AFTER_MINUTES = 10;

const parseDate = (raw, field) => {
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) throw ApiError.badRequest(`${field} is not a valid date and time.`, { [field]: 'expected a date and time' });
  return d;
};

const serializeShift = (s, names = new Map(), departments = new Map()) => ({
  id: String(s._id),
  staff_id: String(s.staff_id),
  staff_name: names.get(String(s.staff_id)) || '',
  department_id: s.department_id ? String(s.department_id) : null,
  department_name: s.department_id ? departments.get(String(s.department_id)) || '' : '',
  starts_at: s.starts_at,
  ends_at: s.ends_at,
  note: s.note || '',
});

const serializeAttendance = (a) => ({
  id: String(a._id),
  staff_id: String(a.staff_id),
  staff_name: a.staff_name,
  clock_in_at: a.clock_in_at,
  clock_out_at: a.clock_out_at,
  minutes: a.clock_out_at ? Math.round((new Date(a.clock_out_at) - new Date(a.clock_in_at)) / 60000) : null,
  late_minutes: a.late_minutes || 0,
  note: a.note || '',
  edited_by: a.edited_by || '',
});

/** Invitations, shift schedules and attendance for a kitchen's team. */
class TeamService {
  /**
   * "Invite employees": sends the employee their sign-in details by SMS
   * and/or email, with a fresh password (the old one stops working).
   */
  async invite(kitchen, staffId) {
    kitchen.assert('staff.invite');
    const staff = await KitchenStaff.findOne({ _id: parseObjectId(staffId, 'staff_id'), vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!staff) throw ApiError.notFound('Employee not found.', 'STAFF_NOT_FOUND');
    if (!staff.phone && !staff.email) throw ApiError.conflict('Add a phone number or email for this employee first.', 'STAFF_NO_CONTACT');
    const vendor = await Vendor.findById(kitchen.vendorId).select('name').lean();
    // A fresh password (and a username if there is none), only its hash kept.
    const crypto = require('crypto');
    const { hashPassword } = require('../../utils/password');
    const { revokeAllSessions } = require('../../utils/sessions');
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const password = Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    let username = staff.username;
    if (!username) {
      const base = staff.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 24) || 'staff';
      username = `${base}.${String(staff._id).slice(-4)}`;
      if (await KitchenStaff.exists({ username, is_current: true })) username = `${base}.${crypto.randomBytes(3).toString('hex')}`;
    }
    await KitchenStaff.updateOne({ _id: staff._id }, { $set: { username, password_hash: await hashPassword(password), password_set_at: new Date() } });
    await revokeAllSessions(KitchenStaff, staff._id);
    const link = `${config.frontendUrl}/login`;
    const text = `${vendor.name} added you to its team on KitchenLink. Sign in at ${link} (Kitchen team member) with username ${username} and password ${password}. Change your password after signing in.`;
    const sent = [];
    if (staff.phone) {
      const result = await sendSms(staff.phone, text).catch(() => ({ status: 'failed' }));
      if (result?.status !== 'failed') sent.push('sms');
    }
    if (staff.email) {
      const result = await sendEmail({
        to: staff.email,
        sensitive: true,
        subject: `Your ${vendor.name} sign-in on KitchenLink`,
        text,
        html: `<p>${escapeHtml(vendor.name)} added you to its team on KitchenLink.</p><p>Sign in at <a href="${escapeHtml(link)}">${escapeHtml(link)}</a> (choose <b>Kitchen team member</b>):</p><p>Username: <b>${escapeHtml(username)}</b><br>Password: <b>${escapeHtml(password)}</b></p><p>Change your password after signing in.</p>`,
      }).catch(() => ({ status: 'failed' }));
      if (result?.status !== 'failed') sent.push('email');
    }
    await activity.record(kitchen, { action: 'staff.invited', target_type: 'staff', target_id: staff._id, summary: `Sent sign-in details to ${staff.name} (${sent.join(' and ') || 'not delivered'})` });
    // The administrator also sees them once, in case the message doesn't arrive.
    return { sent_by: sent, credentials: { username, password } };
  }

  // ------------------------------------------------------------ schedules

  async #names(kitchen) {
    const [staff, departments] = await Promise.all([
      KitchenStaff.find({ vendor_id: kitchen.vendorId }).select('name').lean(),
      departmentService.listForVendor(kitchen.vendorId),
    ]);
    return { names: new Map(staff.map((s) => [String(s._id), s.name])), departments: new Map(departments.map((d) => [String(d._id), d.name])) };
  }

  /** "Manage employee schedules" (everyone sees their own shifts). */
  async shifts(kitchen, query = {}) {
    const from = query.from ? parseDate(query.from, 'from') : new Date(Date.now() - 86400000);
    const to = query.to ? parseDate(query.to, 'to') : new Date(from.getTime() + 14 * 86400000);
    const filter = { vendor_id: kitchen.vendorId, starts_at: { $lt: to }, ends_at: { $gt: from } };
    if (!kitchen.can('staff.schedules')) {
      if (!kitchen.staff) kitchen.assert('staff.schedules');
      filter.staff_id = kitchen.staff._id;
    } else if (query.staff_id && mongoose.isValidObjectId(query.staff_id)) filter.staff_id = new ObjectId(query.staff_id);
    const [rows, ctx] = await Promise.all([StaffShift.find(filter).sort({ starts_at: 1 }).limit(500).lean(), this.#names(kitchen)]);
    return { shifts: rows.map((s) => serializeShift(s, ctx.names, ctx.departments)) };
  }

  async #parseShift(kitchen, body, current = null) {
    const staffId = body.staff_id !== undefined ? parseObjectId(body.staff_id, 'staff_id') : current?.staff_id;
    const staff = await KitchenStaff.findOne({ _id: staffId, vendor_id: kitchen.vendorId, deleted_at: null }).lean();
    if (!staff) throw ApiError.badRequest('That employee is not part of this kitchen.', { staff_id: 'unknown employee' });
    const startsAt = body.starts_at !== undefined ? parseDate(body.starts_at, 'starts_at') : current.starts_at;
    const endsAt = body.ends_at !== undefined ? parseDate(body.ends_at, 'ends_at') : current.ends_at;
    if (endsAt <= startsAt || endsAt - startsAt > 16 * 3600000) throw ApiError.badRequest('A shift ends after it starts and lasts at most 16 hours.', { ends_at: 'out of range' });
    const clash = await StaffShift.findOne({ staff_id: staff._id, starts_at: { $lt: endsAt }, ends_at: { $gt: startsAt }, ...(current ? { _id: { $ne: current._id } } : {}) }).lean();
    if (clash) throw ApiError.conflict(`${staff.name} already has a shift at that time.`, 'SHIFT_OVERLAP');
    return {
      staff_id: staff._id,
      starts_at: startsAt,
      ends_at: endsAt,
      department_id: body.department_id !== undefined ? await departmentService.resolveId(kitchen.vendorId, body.department_id) : current?.department_id || null,
      note: body.note !== undefined ? parseOptionalText(body.note, { field: 'note', max: 140 }) || '' : current?.note || '',
      staff,
    };
  }

  async createShift(kitchen, body = {}) {
    kitchen.assert('staff.schedules');
    const { staff, ...shift } = await this.#parseShift(kitchen, body);
    const saved = await StaffShift.create({ ...shift, vendor_id: kitchen.vendorId, created_by: kitchen.actor.name });
    alerts.toStaff(kitchen.vendorId, staff._id, { title: 'New shift', body: `${saved.starts_at.toLocaleString('en-GB', { timeZone: 'Africa/Kigali' })}`, link: '/vendor-dashboard/staff', type: 'employee_alerts' });
    await activity.record(kitchen, { action: 'staff.shift_created', target_type: 'staff', target_id: staff._id, summary: `Shift for ${staff.name}` });
    const ctx = await this.#names(kitchen);
    return serializeShift(saved.toObject(), ctx.names, ctx.departments);
  }

  async updateShift(kitchen, shiftId, body = {}) {
    kitchen.assert('staff.schedules');
    const current = await StaffShift.findOne({ _id: parseObjectId(shiftId, 'shift_id'), vendor_id: kitchen.vendorId }).lean();
    if (!current) throw ApiError.notFound('Shift not found.', 'SHIFT_NOT_FOUND');
    const { staff, ...shift } = await this.#parseShift(kitchen, body, current);
    const saved = await StaffShift.findOneAndUpdate({ _id: current._id }, { $set: shift }, { returnDocument: 'after' }).lean();
    await activity.record(kitchen, { action: 'staff.shift_updated', target_type: 'staff', target_id: staff._id, summary: `Changed a shift of ${staff.name}` });
    const ctx = await this.#names(kitchen);
    return serializeShift(saved, ctx.names, ctx.departments);
  }

  async deleteShift(kitchen, shiftId) {
    kitchen.assert('staff.schedules');
    const current = await StaffShift.findOneAndDelete({ _id: parseObjectId(shiftId, 'shift_id'), vendor_id: kitchen.vendorId }).lean();
    if (!current) throw ApiError.notFound('Shift not found.', 'SHIFT_NOT_FOUND');
    return { deleted: true, id: String(current._id) };
  }

  // ------------------------------------------------------------ attendance

  /** An employee clocks in (late is worked out from their shift). */
  async clockIn(kitchen, body = {}) {
    if (!kitchen.staff) throw ApiError.badRequest('Only employees clock in.', { staff: 'kitchen account' });
    const now = new Date();
    const shift = await StaffShift.findOne({ staff_id: kitchen.staff._id, starts_at: { $lte: new Date(now.getTime() + 2 * 3600000) }, ends_at: { $gt: now } }).sort({ starts_at: 1 }).lean();
    const late = shift ? Math.max(0, Math.round((now - new Date(shift.starts_at)) / 60000)) : 0;
    try {
      const entry = await StaffAttendance.create({
        vendor_id: kitchen.vendorId,
        staff_id: kitchen.staff._id,
        staff_name: kitchen.staff.name,
        shift_id: shift?._id || null,
        clock_in_at: now,
        late_minutes: late > LATE_AFTER_MINUTES ? late : 0,
        note: parseOptionalText(body.note, { field: 'note', max: 140 }) || '',
      });
      if (entry.late_minutes) {
        alerts.emit(kitchen.vendorId, 'employee_alerts', { title: `${kitchen.staff.name} clocked in ${entry.late_minutes} min late`, link: '/vendor-dashboard/staff', permission: 'staff.attendance' });
      }
      await activity.record(kitchen, { action: 'staff.clock_in', target_type: 'staff', target_id: kitchen.staff._id, summary: `${kitchen.staff.name} clocked in${entry.late_minutes ? ` (${entry.late_minutes} min late)` : ''}` });
      return serializeAttendance(entry.toObject());
    } catch (error) {
      if (error?.code === 11000) throw ApiError.conflict('You are already clocked in.', 'ALREADY_CLOCKED_IN');
      throw error;
    }
  }

  async clockOut(kitchen) {
    if (!kitchen.staff) throw ApiError.badRequest('Only employees clock out.', { staff: 'kitchen account' });
    const saved = await StaffAttendance.findOneAndUpdate({ staff_id: kitchen.staff._id, clock_out_at: null }, { $set: { clock_out_at: new Date() } }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.conflict('You are not clocked in.', 'NOT_CLOCKED_IN');
    await activity.record(kitchen, { action: 'staff.clock_out', target_type: 'staff', target_id: kitchen.staff._id, summary: `${kitchen.staff.name} clocked out` });
    return serializeAttendance(saved);
  }

  async myStatus(kitchen) {
    if (!kitchen.staff) return { clocked_in: false, entry: null, next_shift: null };
    const [open, next] = await Promise.all([
      StaffAttendance.findOne({ staff_id: kitchen.staff._id, clock_out_at: null }).lean(),
      StaffShift.findOne({ staff_id: kitchen.staff._id, ends_at: { $gt: new Date() } }).sort({ starts_at: 1 }).lean(),
    ]);
    return { clocked_in: Boolean(open), entry: open ? serializeAttendance(open) : null, next_shift: next ? serializeShift(next) : null };
  }

  /** "Manage employee attendance": the register, and corrections. */
  async attendance(kitchen, query = {}) {
    kitchen.assert('staff.attendance');
    const from = query.from ? parseDate(query.from, 'from') : new Date(Date.now() - 7 * 86400000);
    const to = query.to ? parseDate(query.to, 'to') : new Date();
    const filter = { vendor_id: kitchen.vendorId, clock_in_at: { $gte: from, $lte: to } };
    if (query.staff_id && mongoose.isValidObjectId(query.staff_id)) filter.staff_id = new ObjectId(query.staff_id);
    const rows = await StaffAttendance.find(filter).sort({ clock_in_at: -1 }).limit(500).lean();
    const totals = new Map();
    for (const a of rows) {
      const t = totals.get(String(a.staff_id)) || { staff_id: String(a.staff_id), staff_name: a.staff_name, minutes: 0, days: 0, late: 0 };
      if (a.clock_out_at) t.minutes += Math.round((new Date(a.clock_out_at) - new Date(a.clock_in_at)) / 60000);
      t.days += 1;
      if (a.late_minutes) t.late += 1;
      totals.set(String(a.staff_id), t);
    }
    return { entries: rows.map(serializeAttendance), totals: [...totals.values()] };
  }

  async editAttendance(kitchen, entryId, body = {}) {
    kitchen.assert('staff.attendance');
    const set = { edited_by: kitchen.actor.name };
    if (body.clock_in_at !== undefined) set.clock_in_at = parseDate(body.clock_in_at, 'clock_in_at');
    if (body.clock_out_at !== undefined) set.clock_out_at = body.clock_out_at ? parseDate(body.clock_out_at, 'clock_out_at') : null;
    if (body.note !== undefined) set.note = parseOptionalText(body.note, { field: 'note', max: 140 }) || '';
    if (set.clock_in_at && set.clock_out_at && set.clock_out_at <= set.clock_in_at) throw ApiError.badRequest('Clock-out is after clock-in.', { clock_out_at: 'before clock-in' });
    const saved = await StaffAttendance.findOneAndUpdate({ _id: parseObjectId(entryId, 'entry_id'), vendor_id: kitchen.vendorId }, { $set: set }, { returnDocument: 'after' }).lean();
    if (!saved) throw ApiError.notFound('Entry not found.', 'ATTENDANCE_NOT_FOUND');
    await activity.record(kitchen, { action: 'staff.attendance_edited', target_type: 'staff', target_id: saved.staff_id, summary: `Corrected attendance of ${saved.staff_name}` });
    return serializeAttendance(saved);
  }
}

module.exports = new TeamService();

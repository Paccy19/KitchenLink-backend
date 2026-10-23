const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseRequiredText,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const { serializeAdminComplaint } = require('../utils/serializers');
const complaintRepository = require('../repositories/complaintRepository');
const adminActionLogService = require('./adminActionLogService');
const notificationService = require('./notificationService');
const supportService = require('./supportService');
const {
  COMPLAINT_STATUSES,
  COMPLAINT_PRIORITIES,
  COMPLAINT_CATEGORIES,
} = require('../models/Complaint');

class AdminComplaintService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.complaintsDefault,
      maxLimit: config.admin.limits.complaintsMax,
    });
    const status = parseEnum(query.status, COMPLAINT_STATUSES, 'status');
    const category = parseEnum(query.category, COMPLAINT_CATEGORIES, 'category');
    const priority = parseEnum(query.priority, COMPLAINT_PRIORITIES, 'priority');

    const { complaints, total } = await complaintRepository.list({
      status,
      category,
      priority,
      search: query.search ? String(query.search).trim() : undefined,
      limit,
      offset,
    });

    const [counts, unread] = await Promise.all([
      complaintRepository.countsByStatus(),
      complaintRepository.countUnreadForAdmin(),
    ]);
    return {
      items: complaints.map(serializeAdminComplaint),
      total,
      page,
      limit,
      counts: {
        open: counts.open || 0,
        in_review: counts.in_review || 0,
        resolved: counts.resolved || 0,
        rejected: counts.rejected || 0,
        unread,
      },
    };
  }

  async getById(complaintId) {
    parseObjectId(complaintId, 'complaint_id');
    let complaint = await complaintRepository.findById(complaintId);
    if (!complaint) {
      throw ApiError.notFound('Complaint not found.', 'COMPLAINT_NOT_FOUND');
    }
    // Opening it means support has read the user's latest message.
    if (complaint.unread_by_admin) {
      complaint = await complaintRepository.update(complaintId, { unread_by_admin: false });
    }
    const actions = await adminActionLogService.listForTarget('complaint', complaintId);
    return { complaint: serializeAdminComplaint(complaint), actions };
  }

  async create(body = {}, admin, req) {
    const subject = parseRequiredText(body.subject, { field: 'subject', min: 3, max: 160 });
    const description =
      parseOptionalText(body.description, { field: 'description', max: 2000 }) || '';
    const category = parseEnum(body.category, COMPLAINT_CATEGORIES, 'category') || 'other';
    const priority = parseEnum(body.priority, COMPLAINT_PRIORITIES, 'priority') || 'medium';

    const complaint = await complaintRepository.create({
      reference: AdminComplaintService.generateReference(),
      subject,
      description,
      category,
      priority,
      status: 'open',
      raised_by: {
        user_id: body.user_id ? parseObjectId(body.user_id, 'user_id') : null,
        role: body.role || 'guest',
        name: parseOptionalText(body.name, { field: 'name', max: 50 }) || '',
        phone: parseOptionalText(body.phone, { field: 'phone', max: 30 }) || '',
      },
      related: {
        order_id: body.order_id ? parseObjectId(body.order_id, 'order_id') : null,
        vendor_id: body.vendor_id ? parseObjectId(body.vendor_id, 'vendor_id') : null,
        driver_id: body.driver_id ? parseObjectId(body.driver_id, 'driver_id') : null,
      },
    });

    await adminActionLogService.record(
      admin,
      {
        action: 'complaint.create',
        target_type: 'complaint',
        target_id: complaint._id,
        target_label: complaint.reference,
      },
      req
    );

    notificationService
      .notifyAdmin({
        type: 'complaint_opened',
        title: 'New complaint logged',
        body: `${complaint.reference} · ${subject} (${priority} priority).`,
        link: `/admin-dashboard/complaints?complaint=${complaint._id}`,
        data: {
          complaint_id: String(complaint._id),
          reference: complaint.reference,
          priority,
        },
      })
      .catch(() => null);

    return { complaint: serializeAdminComplaint(complaint) };
  }

  async update(complaintId, body = {}, admin, req) {
    parseObjectId(complaintId, 'complaint_id');
    const existing = await complaintRepository.findById(complaintId);
    if (!existing) {
      throw ApiError.notFound('Complaint not found.', 'COMPLAINT_NOT_FOUND');
    }

    const payload = {};
    if (body.status !== undefined) {
      payload.status = parseEnum(body.status, COMPLAINT_STATUSES, 'status');
      if (payload.status === 'resolved') {
        payload.resolved_at = new Date();
        payload.resolved_by = admin._id;
      }
    }
    if (body.priority !== undefined) {
      payload.priority = parseEnum(body.priority, COMPLAINT_PRIORITIES, 'priority');
    }
    if (body.assigned_to !== undefined) {
      payload.assigned_to = body.assigned_to
        ? parseObjectId(body.assigned_to, 'assigned_to')
        : null;
    }

    // A reply goes to the user who raised it (the internal `note` does not).
    if (body.reply !== undefined && body.reply !== '') {
      await supportService.adminReply(complaintId, admin, body.reply);
    }

    if (Object.keys(payload).length > 0) {
      const updated = await complaintRepository.update(complaintId, payload);
      if (payload.status && payload.status !== existing.status && ['resolved', 'rejected'].includes(payload.status)) {
        supportService.notifyUser(
          updated,
          payload.status === 'resolved' ? 'Support request resolved' : 'Support request closed',
          `${existing.subject} was marked ${payload.status === 'resolved' ? 'resolved' : 'closed'}. Reply if you still need help.`
        );
      }
    }

    if (body.note) {
      await complaintRepository.addNote(complaintId, {
        author_id: admin._id,
        author_name: admin.name,
        body: parseRequiredText(body.note, { field: 'note', min: 1, max: 2000 }),
        at: new Date(),
      });
    }

    await adminActionLogService.record(
      admin,
      {
        action: 'complaint.update',
        target_type: 'complaint',
        target_id: complaintId,
        target_label: existing.reference,
        metadata: { ...payload, note_added: Boolean(body.note), replied: Boolean(body.reply) },
      },
      req
    );

    return this.getById(complaintId);
  }

  static generateReference() {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `CMP-${stamp}-${rand}`;
  }
}

module.exports = new AdminComplaintService();

const { Complaint } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class ComplaintRepository {
  async create(doc) {
    const complaint = await Complaint.create(doc);
    return complaint.toObject();
  }

  async findById(complaintId) {
    return Complaint.findOne({ _id: complaintId, deleted_at: null }).lean();
  }

  async list({ status, category, priority, search, limit, offset }) {
    const filter = { deleted_at: null };
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { reference: regex },
        { subject: regex },
        { 'raised_by.name': regex },
        { 'raised_by.phone': regex },
      ];
    }

    const [complaints, total] = await Promise.all([
      Complaint.find(filter)
        .sort({ unread_by_admin: -1, last_message_at: -1, created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Complaint.countDocuments(filter),
    ]);

    return { complaints, total };
  }

  async update(complaintId, update) {
    return Complaint.findOneAndUpdate(
      { _id: complaintId, deleted_at: null },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async addNote(complaintId, note) {
    return Complaint.findOneAndUpdate(
      { _id: complaintId, deleted_at: null },
      { $push: { notes: note } },
      { returnDocument: 'after' }
    ).lean();
  }

  async countsByStatus() {
    const rows = await Complaint.aggregate([
      { $match: { deleted_at: null } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});
  }

  /* ------------------- support conversations (users) ------------------- */

  async listByUser(role, userId, { limit = 50 } = {}) {
    return Complaint.find({ deleted_at: null, 'raised_by.role': role, 'raised_by.user_id': userId })
      .sort({ last_message_at: -1, created_at: -1 })
      .limit(limit)
      .lean();
  }

  async findForUser(role, userId, complaintId) {
    return Complaint.findOne({
      _id: complaintId,
      deleted_at: null,
      'raised_by.role': role,
      'raised_by.user_id': userId,
    }).lean();
  }

  async countUnreadForUser(role, userId) {
    return Complaint.countDocuments({
      deleted_at: null,
      'raised_by.role': role,
      'raised_by.user_id': userId,
      unread_by_user: true,
    });
  }

  /** Adds a message to the conversation and applies `set` in one write. */
  async pushMessage(complaintId, message, set = {}) {
    return Complaint.findOneAndUpdate(
      { _id: complaintId, deleted_at: null },
      { $push: { messages: message }, $set: { last_message_at: message.at, ...set } },
      { returnDocument: 'after' }
    ).lean();
  }

  async countUnreadForAdmin() {
    return Complaint.countDocuments({ deleted_at: null, unread_by_admin: true });
  }

  async countOpen() {
    return Complaint.countDocuments({
      deleted_at: null,
      status: { $in: ['open', 'in_review'] },
    });
  }
}

module.exports = new ComplaintRepository();

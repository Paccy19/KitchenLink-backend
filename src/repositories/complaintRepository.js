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
        .sort({ created_at: -1 })
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
      { new: true }
    ).lean();
  }

  async addNote(complaintId, note) {
    return Complaint.findOneAndUpdate(
      { _id: complaintId, deleted_at: null },
      { $push: { notes: note } },
      { new: true }
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

  async countOpen() {
    return Complaint.countDocuments({
      deleted_at: null,
      status: { $in: ['open', 'in_review'] },
    });
  }
}

module.exports = new ComplaintRepository();

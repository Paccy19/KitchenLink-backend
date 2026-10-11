const { AdminActionLog } = require('../models');

class AdminActionLogRepository {
  async create(doc) {
    const log = await AdminActionLog.create(doc);
    return log.toObject();
  }

  async list({ adminId, targetType, action, limit, offset }) {
    const filter = {};
    if (adminId) filter.admin_id = adminId;
    if (targetType) filter.target_type = targetType;
    if (action) filter.action = action;

    const [logs, total] = await Promise.all([
      AdminActionLog.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      AdminActionLog.countDocuments(filter),
    ]);

    return { logs, total };
  }

  async listForTarget(targetType, targetId, { limit = 50 } = {}) {
    return AdminActionLog.find({ target_type: targetType, target_id: String(targetId) })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new AdminActionLogRepository();

const { serializeAdminAction } = require('../utils/serializers');
const { parseAdminListQuery } = require('../utils/adminValidators');
const adminActionLogRepository = require('../repositories/adminActionLogRepository');
const adminRepository = require('../repositories/adminRepository');
const config = require('../config');

class AdminActionLogService {
  /**
   * Persist an audit entry. Never throws into the request path — a failed log
   * write should not fail the admin operation it describes.
   */
  async record(admin, entry = {}, req) {
    try {
      if (!admin) return null;
      const log = await adminActionLogRepository.create({
        admin_id: admin._id,
        admin_name: admin.name,
        admin_email: admin.email,
        action: entry.action || 'unknown',
        target_type: entry.target_type || 'system',
        target_id: entry.target_id ? String(entry.target_id) : '',
        target_label: entry.target_label || '',
        metadata: entry.metadata || {},
        ip: this.#clientIp(req),
      });
      return serializeAdminAction(log);
    } catch (error) {
      console.error('[admin audit] failed to record action', error);
      return null;
    }
  }

  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.actionsDefault,
      maxLimit: config.admin.limits.actionsMax,
    });
    const { logs, total } = await adminActionLogRepository.list({
      adminId: query.admin_id,
      targetType: query.target_type,
      action: query.action,
      limit,
      offset,
    });
    return { items: logs.map(serializeAdminAction), total, page, limit };
  }

  async listForTarget(targetType, targetId) {
    const logs = await adminActionLogRepository.listForTarget(targetType, targetId);
    return logs.map(serializeAdminAction);
  }

  async listAdmins() {
    const { admins } = await adminRepository.list({ limit: 100, offset: 0 });
    return admins;
  }

  #clientIp(req) {
    if (!req) return '';
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || '';
  }
}

module.exports = new AdminActionLogService();

const config = require('../config');
const {
  parseAdminListQuery,
  parseDateRange,
  parseEnum,
} = require('../utils/adminValidators');
const { serializeAdminPayment } = require('../utils/serializers');
const paymentRepository = require('../repositories/paymentRepository');

const PAYMENT_STATUSES = ['pending', 'processing', 'successful', 'failed', 'refunded'];
const PAYMENT_METHODS = config.orders.paymentMethods.map((method) => method.code);

class AdminPaymentService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, PAYMENT_STATUSES, 'status');
    const method = parseEnum(query.method, PAYMENT_METHODS, 'method');
    const { from, to } = parseDateRange(query);

    const { payments, total } = await paymentRepository.adminList({
      status,
      method,
      from,
      to,
      search: query.search ? String(query.search).trim() : undefined,
      limit,
      offset,
    });
    return { items: payments.map(serializeAdminPayment), total, page, limit };
  }

  async summary(query = {}) {
    const { from, to } = parseDateRange(query);
    const start = from || new Date(0);
    const end = to || new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [totals, byStatus] = await Promise.all([
      paymentRepository.totalsBetween({ start, end }),
      paymentRepository.totalsByStatus(),
    ]);
    return {
      successful_total_rwf: totals.total,
      successful_count: totals.count,
      by_status: byStatus.map((row) => ({
        status: row._id,
        total_rwf: row.total,
        count: row.count,
      })),
    };
  }
}

module.exports = new AdminPaymentService();
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;

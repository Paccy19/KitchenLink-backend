const { Transaction } = require('../models');

class TransactionRepository {
  async create(doc) {
    const transaction = await Transaction.create(doc);
    return transaction.toObject();
  }

  async findByOrder(orderId) {
    return Transaction.find({ order_id: orderId })
      .sort({ created_at: 1 })
      .lean();
  }

  async list({ type, orderId, vendorId, driverId, limit = 50, offset = 0 } = {}) {
    const filter = {};
    if (type) filter.type = type;
    if (orderId) filter.order_id = orderId;
    if (vendorId) filter.vendor_id = vendorId;
    if (driverId) filter.driver_id = driverId;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
    ]);
    return { transactions, total };
  }

  /** Sum of amounts matching a filter (e.g. all commission entries). */
  async sum(filter = {}) {
    const [row] = await Transaction.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$amount_rwf' } } },
    ]);
    return row?.total ?? 0;
  }

  /** Rename legacy entry types/directions (idempotent). */
  async migrateLegacyTypes() {
    const renamed = await Promise.all([
      Transaction.updateMany({ type: 'vendor_payout' }, { $set: { type: 'vendor_earning', direction: 'internal' } }),
      Transaction.updateMany({ type: 'driver_payout' }, { $set: { type: 'driver_earning', direction: 'internal' } }),
      Transaction.updateMany({ type: 'commission', direction: { $ne: 'internal' } }, { $set: { direction: 'internal' } }),
    ]);
    return renamed.reduce((count, result) => count + (result.modifiedCount ?? 0), 0);
  }

  async orderIdsWithType(type) {
    return Transaction.distinct('order_id', { type, order_id: { $ne: null } });
  }

  async listDriverEarningOrders() {
    return Transaction.find({ type: 'driver_earning', order_id: { $ne: null } })
      .select({ order_id: 1, created_at: 1 })
      .lean();
  }

  async totalsByType() {
    return Transaction.aggregate([
      { $match: { status: { $ne: 'refunded' } } },
      {
        $group: {
          _id: '$type',
          total_rwf: { $sum: '$amount_rwf' },
          count: { $sum: 1 },
        },
      },
    ]);
  }
}

module.exports = new TransactionRepository();

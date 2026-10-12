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

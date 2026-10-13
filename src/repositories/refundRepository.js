const { Refund } = require('../models');

class RefundRepository {
  /** Creates the order's refund once; a second call returns the existing one. */
  async createOnce(doc) {
    try {
      return (await Refund.create(doc)).toObject();
    } catch (error) {
      if (error?.code === 11000) return Refund.findOne({ order_id: doc.order_id }).lean();
      throw error;
    }
  }

  async findById(refundId) {
    return Refund.findById(refundId).lean();
  }

  async findByOrder(orderId) {
    return Refund.findOne({ order_id: orderId }).lean();
  }

  async findForCustomer(customerId, orderId) {
    return Refund.findOne({ order_id: orderId, customer_id: customerId }).lean();
  }

  async listByCustomer(customerId, { limit = 50 } = {}) {
    return Refund.find({ customer_id: customerId }).sort({ created_at: -1 }).limit(limit).lean();
  }

  async listByOrders(orderIds) {
    return Refund.find({ order_id: { $in: orderIds } }).lean();
  }

  async adminList({ status, search, limit, offset }) {
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ order_number: pattern }, { 'destination.phone': pattern }, { reference: pattern }];
    }
    const [refunds, total] = await Promise.all([
      Refund.find(filter)
        .sort({ status: -1, created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('customer_id', 'name phone_number')
        .populate('vendor_id', 'name')
        .lean(),
      Refund.countDocuments(filter),
    ]);
    return { refunds, total };
  }

  /** Totals per status, for the admin summary and the books. */
  async totals() {
    const rows = await Refund.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount_rwf' } } },
    ]);
    const out = {};
    for (const status of ['pending', 'completed', 'failed']) {
      const row = rows.find((r) => r._id === status);
      out[status] = { count: row?.count ?? 0, amount_rwf: row?.amount ?? 0 };
    }
    return out;
  }

  /** Money still owed to customers (not yet sent back). */
  async totalOwed() {
    const [row] = await Refund.aggregate([
      { $match: { status: { $in: ['pending', 'failed'] } } },
      { $group: { _id: null, total: { $sum: '$amount_rwf' } } },
    ]);
    return row?.total ?? 0;
  }

  /** Moves a refund on only from one of `from`, so two admins cannot both send it. */
  async transition(refundId, from, update) {
    return Refund.findOneAndUpdate(
      { _id: refundId, status: { $in: from } },
      update,
      { new: true }
    ).lean();
  }

  async update(refundId, update) {
    return Refund.findByIdAndUpdate(refundId, update, { new: true }).lean();
  }
}

module.exports = new RefundRepository();

const { Refund } = require('../models');

class RefundRepository {
  /** Creates the order's refund of this kind once; a second call returns the existing one. */
  async createOnce(doc) {
    try {
      return (await Refund.create(doc)).toObject();
    } catch (error) {
      if (error?.code === 11000) {
        return Refund.findOne({ order_id: doc.order_id, kind: doc.kind || 'order_cancelled' }).lean();
      }
      throw error;
    }
  }

  async findById(refundId) {
    return Refund.findById(refundId).lean();
  }

  /** The order's latest refund (a cancellation, or a delivery fee adjustment). */
  async findByOrder(orderId) {
    return Refund.findOne({ order_id: orderId }).sort({ created_at: -1 }).lean();
  }

  async findByOrderAndKind(orderId, kind) {
    return Refund.findOne({ order_id: orderId, kind }).lean();
  }

  async listByOrder(orderId) {
    return Refund.find({ order_id: orderId }).sort({ created_at: 1 }).lean();
  }

  /** What this order has already been refunded (sent or still owed), other kinds than `exceptKind`. */
  async totalForOrder(orderId, { exceptKind = null } = {}) {
    const match = { order_id: orderId };
    if (exceptKind) match.kind = { $ne: exceptKind };
    const [row] = await Refund.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$amount_rwf' } } }]);
    return row?.total ?? 0;
  }

  /** The customer's refund for this order still to be sent (else the latest one). */
  async findForCustomer(customerId, orderId) {
    const open = await Refund.findOne({ order_id: orderId, customer_id: customerId, status: { $ne: 'completed' } })
      .sort({ created_at: -1 })
      .lean();
    return open || Refund.findOne({ order_id: orderId, customer_id: customerId }).sort({ created_at: -1 }).lean();
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
      { returnDocument: 'after' }
    ).lean();
  }

  async update(refundId, update) {
    return Refund.findByIdAndUpdate(refundId, update, { returnDocument: 'after' }).lean();
  }
}

module.exports = new RefundRepository();

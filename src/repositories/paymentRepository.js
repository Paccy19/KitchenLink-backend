const { Payment } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class PaymentRepository {
  async create(doc) {
    const payment = await Payment.create(doc);
    return payment.toObject();
  }

  async findById(paymentId) {
    return Payment.findById(paymentId).lean();
  }

  async findSuccessfulByOrder(orderId) {
    return Payment.findOne({ order_id: orderId, status: 'successful' })
      .sort({ paid_at: -1, created_at: -1 })
      .lean();
  }

  async findLatestByOrder(orderId) {
    return Payment.findOne({ order_id: orderId })
      .sort({ created_at: -1 })
      .lean();
  }

  async update(paymentId, update) {
    return Payment.findOneAndUpdate(
      { _id: paymentId },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ status, method, from, to, search, limit, offset }) {
    const filter = {};
    if (status) filter.status = status;
    if (method) filter.method = method;
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = from;
      if (to) filter.created_at.$lte = to;
    }
    if (search) {
      filter.$or = [
        { reference: new RegExp(escapeRegex(search), 'i') },
        { provider: new RegExp(escapeRegex(search), 'i') },
      ];
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('order_id', 'order_number')
        .populate('customer_id', 'name phone_number')
        .lean(),
      Payment.countDocuments(filter),
    ]);
    return { payments, total };
  }

  async totalsBetween({ start, end }) {
    const rows = await Payment.aggregate([
      {
        $match: {
          created_at: { $gte: start, $lt: end },
          status: 'successful',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount_rwf' }, count: { $sum: 1 } } },
    ]);
    return rows[0] || { total: 0, count: 0 };
  }

  async totalsByStatus() {
    const rows = await Payment.aggregate([
      { $group: { _id: '$status', total: { $sum: '$amount_rwf' }, count: { $sum: 1 } } },
    ]);
    return rows;
  }
}

module.exports = new PaymentRepository();

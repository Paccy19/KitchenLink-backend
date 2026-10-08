const { Payment } = require('../models');

class PaymentRepository {
  async create(doc) {
    const payment = await Payment.create(doc);
    return payment.toObject();
  }

  async findById(paymentId) {
    return Payment.findById(paymentId).lean();
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
      { new: true }
    ).lean();
  }
}

module.exports = new PaymentRepository();

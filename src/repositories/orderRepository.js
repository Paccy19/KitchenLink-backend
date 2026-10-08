const { Order } = require('../models');

class OrderRepository {
  async create(doc) {
    const order = await Order.create(doc);
    return order.toObject();
  }

  async findById(orderId) {
    return Order.findById(orderId).lean();
  }

  async findByCustomerAndId(customerId, orderId) {
    return Order.findOne({ _id: orderId, customer_id: customerId }).lean();
  }

  async listByCustomer(customerId, { status, limit, offset }) {
    const filter = { customer_id: customerId };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return { orders, total };
  }

  async update(orderId, update) {
    return Order.findOneAndUpdate({ _id: orderId }, { $set: update }, { new: true }).lean();
  }

  async pushHistory(orderId, entry) {
    await Order.updateOne(
      { _id: orderId },
      { $push: { status_history: entry } }
    );
  }
}

module.exports = new OrderRepository();

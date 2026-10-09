const mongoose = require('mongoose');
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

  async findByVendorAndId(vendorId, orderId) {
    return Order.findOne({ _id: orderId, vendor_id: vendorId }).lean();
  }

  async listByVendor(vendorId, { statuses, limit, offset, sort }) {
    const filter = { vendor_id: vendorId };
    if (statuses && statuses.length > 0) filter.status = { $in: statuses };

    const sortSpec =
      {
        oldest: { created_at: 1 },
        total_desc: { total_rwf: -1, created_at: -1 },
        total_asc: { total_rwf: 1, created_at: -1 },
      }[sort] || { created_at: -1 };

    const [orders, total] = await Promise.all([
      Order.find(filter).sort(sortSpec).skip(offset).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    return { orders, total };
  }

  /**
   * Vendor dashboard counters for a time window.
   * Completed orders without a completed_at timestamp fall back to updated_at.
   */
  async dashboardMetrics(vendorId, { start, end, pendingStatuses }) {
    const vendorObjectId = new mongoose.Types.ObjectId(String(vendorId));

    const [todayOrders, pendingOrders, completedAgg] = await Promise.all([
      Order.countDocuments({
        vendor_id: vendorObjectId,
        created_at: { $gte: start, $lt: end },
      }),
      Order.countDocuments({
        vendor_id: vendorObjectId,
        status: { $in: pendingStatuses },
      }),
      Order.aggregate([
        { $match: { vendor_id: vendorObjectId, status: 'delivered' } },
        {
          $addFields: {
            completed_effective: { $ifNull: ['$completed_at', '$updated_at'] },
          },
        },
        { $match: { completed_effective: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            sales: { $sum: '$total_rwf' },
          },
        },
      ]),
    ]);

    const completed = completedAgg[0] || { count: 0, sales: 0 };

    return {
      todayOrders,
      pendingOrders,
      completedOrders: completed.count,
      todaySalesRwf: completed.sales,
    };
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

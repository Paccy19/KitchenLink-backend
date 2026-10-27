const mongoose = require('mongoose');
const { Order } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class OrderRepository {
  async create(doc) {
    const order = await Order.create(doc);
    return order.toObject();
  }

  async findById(orderId) {
    return Order.findById(orderId).lean();
  }

  /** Pickup code (never selected by default). */
  async findPickupCode(orderId) {
    const order = await Order.findById(orderId).select('+pickup_code').lean();
    return order?.pickup_code || null;
  }

  /**
   * Turns a pickup order into a delivery order, only while it is still an
   * uncollected pickup (atomic, so it can't race the kitchen confirming the
   * pickup code). Returns null when it was collected, cancelled or switched.
   */
  async switchPickupToDelivery(orderId, allowedStatuses, { set, inc, note, at, historyStatus }) {
    return Order.findOneAndUpdate(
      { _id: orderId, fulfillment: 'pickup', status: { $in: allowedStatuses } },
      {
        $set: { ...set, fulfillment: 'delivery', pickup_code: '', pickup_code_attempts: 0 },
        $inc: inc,
        // Same status as before; the note records the switch on the timeline.
        $push: { status_history: { status: historyStatus, at, note } },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  /**
   * Completes a pickup order when the code matches (atomically, so it can't
   * be collected twice). Returns null if the code was wrong or it's not ready.
   */
  async collectPickup(orderId, code, { at, note = 'Collected by the customer (pickup code confirmed)' }) {
    return Order.findOneAndUpdate(
      // Pickup orders, and orders a nationwide kitchen delivered itself.
      { _id: orderId, fulfillment: { $in: ['pickup', 'vendor_delivery'] }, status: 'ready', pickup_code: code },
      {
        $set: { status: 'delivered', delivered_at: at, completed_at: at, collected_at: at },
        $push: { status_history: { status: 'delivered', at, note } },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  async recordPickupAttempt(orderId) {
    return Order.findOneAndUpdate(
      { _id: orderId },
      { $inc: { pickup_code_attempts: 1 } },
      { returnDocument: 'after' }
    ).lean();
  }

  async findByCustomerAndId(customerId, orderId) {
    return Order.findOne({ _id: orderId, customer_id: customerId }).lean();
  }

  async findByVendorAndId(vendorId, orderId) {
    return Order.findOne({ _id: orderId, vendor_id: vendorId }).lean();
  }

  async findDetailedById(orderId) {
    return Order.findById(orderId)
      .populate('vendor_id', 'name neighborhood')
      .populate('customer_id', 'name phone_number')
      .populate('driver_id', 'name phone')
      .lean();
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

    const [
      todayOrders,
      pendingOrders,
      newOrders,
      preparingOrders,
      readyOrders,
      completedOrdersTotal,
      cancelledOrders,
      activeAgg,
      completedAgg,
    ] = await Promise.all([
      Order.countDocuments({
        vendor_id: vendorObjectId,
        created_at: { $gte: start, $lt: end },
      }),
      Order.countDocuments({
        vendor_id: vendorObjectId,
        status: { $in: pendingStatuses },
      }),
      Order.countDocuments({ vendor_id: vendorObjectId, status: 'placed' }),
      Order.countDocuments({ vendor_id: vendorObjectId, status: 'preparing' }),
      Order.countDocuments({
        vendor_id: vendorObjectId,
        status: { $in: ['ready', 'assigned', 'picked_up', 'out_for_delivery'] },
      }),
      Order.countDocuments({ vendor_id: vendorObjectId, status: 'delivered' }),
      Order.countDocuments({ vendor_id: vendorObjectId, status: 'cancelled' }),
      Order.aggregate([
        { $match: { vendor_id: vendorObjectId, status: { $in: pendingStatuses } } },
        { $group: { _id: null, total: { $sum: '$subtotal_rwf' } } },
      ]),
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
            sales: { $sum: '$subtotal_rwf' },
          },
        },
      ]),
    ]);

    const completed = completedAgg[0] || { count: 0, sales: 0 };
    const active = activeAgg[0] || { total: 0 };

    return {
      todayOrders,
      pendingOrders,
      completedOrders: completed.count,
      todaySalesRwf: completed.sales,
      newOrders,
      preparingOrders,
      readyOrders,
      completedOrdersTotal,
      cancelledOrders,
      activeSalesRwf: active.total,
    };
  }

  /**
   * Food-subtotal value of orders still in-flight (not completed/cancelled).
   * The delivery fee is excluded so vendor pending balances reflect food only.
   */
  async activeSalesTotal(vendorId, statuses) {
    const vendorObjectId = new mongoose.Types.ObjectId(String(vendorId));
    const [result] = await Order.aggregate([
      { $match: { vendor_id: vendorObjectId, status: { $in: statuses } } },
      { $group: { _id: null, total: { $sum: '$subtotal_rwf' } } },
    ]);
    return result?.total ?? 0;
  }

  async listByCustomer(customerId, { status, limit, offset }) {    const filter = { customer_id: customerId };
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
    return Order.findOneAndUpdate({ _id: orderId }, { $set: update }, { returnDocument: 'after' }).lean();
  }

  /**
   * Big events still owing their balance, due before `dueBefore`: the deposit
   * is paid and the order is neither cancelled nor handed over.
   */
  async findUnpaidBalances(dueBefore) {
    return Order.find({
      'deposit.balance_rwf': { $ne: null },
      'deposit.balance_paid_at': null,
      'deposit.balance_due_at': { $lte: dueBefore },
      payment_status: 'paid',
      status: { $nin: ['cancelled', 'delivered'] },
    }).lean();
  }

  /** Records a balance reminder once; false when it was already sent. */
  async markBalanceReminder(orderId, key) {
    const result = await Order.updateOne(
      { _id: orderId, 'deposit.reminders_sent': { $ne: key } },
      { $addToSet: { 'deposit.reminders_sent': key } }
    );
    return result.modifiedCount > 0;
  }

  async pushHistory(orderId, entry) {
    await Order.updateOne(
      { _id: orderId },
      { $push: { status_history: entry } }
    );
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ statuses, vendorId, customerId, driverId, fulfillment, from, to, search, limit, offset }) {
    const filter = {};
    if (statuses && statuses.length > 0) filter.status = { $in: statuses };
    // Orders from before pickup existed have no field: they are deliveries.
    if (fulfillment === 'pickup') filter.fulfillment = 'pickup';
    if (fulfillment === 'delivery') filter.fulfillment = { $ne: 'pickup' };
    if (vendorId) filter.vendor_id = vendorId;
    if (customerId) filter.customer_id = customerId;
    if (driverId) filter.driver_id = driverId;
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = from;
      if (to) filter.created_at.$lte = to;
    }
    if (search) {
      filter.order_number = new RegExp(escapeRegex(search), 'i');
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('vendor_id', 'name neighborhood')
        .populate('customer_id', 'name phone_number')
        .populate('driver_id', 'name phone')
        .lean(),
      Order.countDocuments(filter),
    ]);
    return { orders, total };
  }

  async countByStatuses(statuses) {
    const rows = await Order.aggregate([
      { $match: { status: { $in: statuses } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});
  }

  async countCreatedBetween(start, end) {
    return Order.countDocuments({ created_at: { $gte: start, $lt: end } });
  }

  async salesTotalsBetween({ start, end, completedStatuses }) {
    const [row] = await Order.aggregate([
      {
        $match: {
          status: { $in: completedStatuses },
          created_at: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          gross: { $sum: '$total_rwf' },
          delivery_fees: { $sum: '$delivery_fee_rwf' },
        },
      },
    ]);
    return row || { orders: 0, gross: 0, delivery_fees: 0 };
  }

  async salesSeries({ start, end, completedStatuses, granularity = 'day', timezoneOffsetHours = 2 }) {
    const format = granularity === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const rows = await Order.aggregate([
      {
        $match: {
          status: { $in: completedStatuses },
          created_at: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format,
              date: '$created_at',
              timezone: `+${String(timezoneOffsetHours).padStart(2, '0')}:00`,
            },
          },
          orders: { $sum: 1 },
          gross: { $sum: '$total_rwf' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((row) => ({
      bucket: row._id,
      orders: row.orders,
      gross_rwf: row.gross,
    }));
  }

  /**
   * Customer money the platform is still holding: paid orders not yet
   * completed, plus delivery fees of completed orders no rider has been
   * credited for yet.
   */
  async heldTotal() {
    const [row] = await Order.aggregate([
      // Only orders that can still hold money: held ones, and settled ones
      // whose delivery fee no rider has been credited for. (Settled orders with
      // the rider paid add 0, so leaving them out keeps the same total while
      // the query stays fast as orders pile up.)
      {
        $match: {
          $or: [
            { settlement_status: 'held' },
            { settlement_status: 'settled', rider_payout_settled_at: null },
          ],
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $eq: ['$settlement_status', 'held'] },
                '$total_rwf',
                { $cond: [{ $ifNull: ['$rider_payout_settled_at', false] }, 0, '$delivery_fee_rwf'] },
              ],
            },
          },
        },
      },
    ]);
    return row?.total ?? 0;
  }

  /**
   * Atomically moves an order's settlement from one state to the next. Returns
   * the updated order, or null if another request already moved it, so each
   * money step (hold, settle, refund) happens exactly once.
   */
  async claimSettlement(orderId, from, to, extra = {}) {
    return Order.findOneAndUpdate(
      { _id: orderId, settlement_status: from },
      { $set: { settlement_status: to, ...extra } },
      { returnDocument: 'after' }
    ).lean();
  }

  async listPaidExcept(orderIds = []) {
    return Order.find({ payment_status: 'paid', _id: { $nin: orderIds } }).lean();
  }

  async markRiderSettled(orderId, at = new Date()) {
    return Order.updateOne(
      { _id: orderId, rider_payout_settled_at: null },
      { $set: { rider_payout_settled_at: at } }
    );
  }

  async listOpenByVendor(vendorId, statuses) {
    return Order.find({ vendor_id: vendorId, status: { $in: statuses } }).lean();
  }

  async cancelOpenByVendor(vendorId, statuses, reason) {
    const now = new Date();
    const result = await Order.updateMany(
      { vendor_id: vendorId, status: { $in: statuses } },
      {
        $set: {
          status: 'cancelled',
          cancelled_at: now,
          cancel_reason: reason || 'Cancelled by admin',
          updated_at: now,
        },
        $push: {
          status_history: {
            status: 'cancelled',
            at: now,
            note: reason || 'Cancelled by admin',
          },
        },
      }
    );
    return result.modifiedCount ?? 0;
  }

  async topVendors({ start, end, completedStatuses, limit = 5 }) {
    return Order.aggregate([
      {
        $match: {
          status: { $in: completedStatuses },
          created_at: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: '$vendor_id',
          orders: { $sum: 1 },
          gross: { $sum: '$total_rwf' },
        },
      },
      { $sort: { gross: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'vendors',
          localField: '_id',
          foreignField: '_id',
          as: 'vendor',
        },
      },
      { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          vendor_id: '$_id',
          name: '$vendor.name',
          orders: 1,
          gross_rwf: '$gross',
        },
      },
    ]);
  }
}

module.exports = new OrderRepository();

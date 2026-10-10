const { Delivery } = require('../models');

const POPULATE = [
  { path: 'vendor_id', select: 'name phone address neighborhood location' },
  { path: 'customer_id', select: 'name phone_number' },
  { path: 'driver_id', select: 'name phone vehicle_type plate_number rating' },
];

class DeliveryRepository {
  async create(doc) {
    const delivery = await Delivery.create(doc);
    return delivery.toObject();
  }

  async findById(deliveryId) {
    return Delivery.findById(deliveryId).lean();
  }

  async findByIdPopulated(deliveryId) {
    return Delivery.findById(deliveryId).populate(POPULATE).lean();
  }

  async findByOrderId(orderId) {
    return Delivery.findOne({ order_id: orderId }).lean();
  }

  async findByDriverAndId(driverId, deliveryId) {
    return Delivery.findOne({ _id: deliveryId, driver_id: driverId }).lean();
  }

  async findActiveByDriver(driverId, activeStatuses) {
    return Delivery.findOne({
      driver_id: driverId,
      status: { $in: activeStatuses },
    })
      .sort({ assigned_at: -1 })
      .populate(POPULATE)
      .lean();
  }

  /** Unassigned, still-dispatchable deliveries around a pickup point. */
  async listAvailable({ statuses, neighborhoods = [] }) {
    const filter = {
      status: { $in: statuses },
      driver_id: null,
    };
    if (neighborhoods.length > 0) {
      filter['pickup_location.neighborhood'] = { $in: neighborhoods };
    }
    return Delivery.find(filter).sort({ created_at: 1 }).lean();
  }

  async listByDriver(driverId, { statuses, limit, offset }) {
    const filter = { driver_id: driverId };
    if (statuses && statuses.length > 0) filter.status = { $in: statuses };

    const [deliveries, total] = await Promise.all([
      Delivery.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate(POPULATE)
        .lean(),
      Delivery.countDocuments(filter),
    ]);

    return { deliveries, total };
  }

  async listByVendor(vendorId, { statuses, limit, offset }) {
    const filter = { vendor_id: vendorId };
    if (statuses && statuses.length > 0) filter.status = { $in: statuses };

    const [deliveries, total] = await Promise.all([
      Delivery.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Delivery.countDocuments(filter),
    ]);

    return { deliveries, total };
  }

  /**
   * Atomically claims an unassigned delivery for a driver.
   * Returns null when another driver won the race or the offer expired.
   */
  async claim(driverId, deliveryId, { status, assignedAt }) {
    return Delivery.findOneAndUpdate(
      {
        _id: deliveryId,
        driver_id: null,
        status: { $in: ['pending', 'ready_for_pickup', 'accepted'] },
      },
      {
        $set: {
          driver_id: driverId,
          status,
          assigned_at: assignedAt,
        },
        $push: {
          status_history: {
            status,
            at: assignedAt,
            note: 'Delivery accepted by driver',
            by: 'driver',
          },
        },
      },
      { new: true }
    ).lean();
  }

  async update(deliveryId, update) {
    return Delivery.findOneAndUpdate(
      { _id: deliveryId },
      { $set: update },
      { new: true }
    ).lean();
  }

  async pushHistory(deliveryId, entry) {
    await Delivery.updateOne({ _id: deliveryId }, { $push: { status_history: entry } });
  }

  async addRejection(deliveryId, driverId) {
    return Delivery.updateOne(
      { _id: deliveryId },
      { $addToSet: { rejected_by: driverId } }
    );
  }

  async setOffers(deliveryId, { offers, broadcastCount, lastBroadcastAt, offerExpiresAt }) {
    return Delivery.updateOne(
      { _id: deliveryId },
      {
        $set: {
          'dispatch.offers': offers,
          'dispatch.broadcast_count': broadcastCount,
          'dispatch.last_broadcast_at': lastBroadcastAt,
          'dispatch.offer_expires_at': offerExpiresAt,
        },
      }
    );
  }

  /** Deliveries still assigned to a driver that should be handed back. */
  async findAssignedToDriver(driverId, statuses) {
    return Delivery.find({
      driver_id: driverId,
      status: { $in: statuses },
    }).lean();
  }

  /** Deliveries sitting unassigned past their offer window. */
  async findStaleUnassigned(statuses, before) {
    return Delivery.find({
      status: { $in: statuses },
      driver_id: null,
      $or: [
        { 'dispatch.offer_expires_at': { $lt: before } },
        { 'dispatch.offer_expires_at': null },
        { 'dispatch.offer_expires_at': { $exists: false } },
      ],
    }).lean();
  }

  async countByDriver(driverId) {
    return Delivery.countDocuments({ driver_id: driverId });
  }

  async aggregateDriverStats(driverId, { start, end }) {
    const mongoose = require('mongoose');
    const driverObjectId = new mongoose.Types.ObjectId(String(driverId));

    const [today, allTime] = await Promise.all([
      Delivery.aggregate([
        {
          $match: {
            driver_id: driverObjectId,
            status: { $in: ['delivered', 'completed'] },
            delivered_at: { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            earnings: { $sum: '$promised_earnings_rwf' },
          },
        },
      ]),
      Delivery.aggregate([
        {
          $match: {
            driver_id: driverObjectId,
            status: { $in: ['delivered', 'completed'] },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            earnings: { $sum: '$promised_earnings_rwf' },
          },
        },
      ]),
    ]);

    return {
      today: today[0] || { count: 0, earnings: 0 },
      total: allTime[0] || { count: 0, earnings: 0 },
    };
  }
}

module.exports = new DeliveryRepository();

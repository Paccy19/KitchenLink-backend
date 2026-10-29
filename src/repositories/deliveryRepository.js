const { Delivery } = require('../models');

const POPULATE = [
  { path: 'vendor_id', select: 'name phone address neighborhood location estimated_prep_time' },
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
            note: 'Delivery accepted by delivery worker',
            by: 'driver',
          },
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  async update(deliveryId, update) {
    return Delivery.findOneAndUpdate(
      { _id: deliveryId },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async pushHistory(deliveryId, entry) {
    await Delivery.updateOne({ _id: deliveryId }, { $push: { status_history: entry } });
  }

  /** Assigned, still not collected, and past the automatic reassign time. */
  async findDueForReassign(now) {
    return Delivery.find({
      status: 'assigned_to_driver',
      driver_id: { $ne: null },
      picked_up_at: null,
      pickup_reassign_at: { $ne: null, $lte: now },
    }).lean();
  }

  /**
   * Takes the delivery away from `driverId` only if they still have it and
   * haven't collected it (atomic, so a pickup at the same moment wins).
   */
  async releaseIfStillAssigned(deliveryId, driverId, update) {
    return Delivery.findOneAndUpdate(
      { _id: deliveryId, driver_id: driverId, status: 'assigned_to_driver' },
      { $set: { ...update, driver_id: null, assigned_at: null } },
      { returnDocument: 'after' }
    ).lean();
  }

  /** Keeps a late worker's record when the delivery moves to someone else. */
  async pushLateRecord(deliveryId, record) {
    await Delivery.updateOne({ _id: deliveryId }, { $push: { late_history: record } });
  }

  /**
   * Late workers who lost the order have no delivery fee of their own here,
   * so there is nothing to take a penalty from: their pending charges are
   * waived when the order is delivered by someone else.
   */
  async waivePendingLateCharges(deliveryId, note = '') {
    return Delivery.updateOne(
      { _id: deliveryId },
      {
        $set: {
          'late_history.$[record].charge_status': 'waived',
          'late_history.$[record].charge_rwf': null,
          'late_history.$[record].note': note,
        },
      },
      { arrayFilters: [{ 'record.charge_status': 'pending' }] }
    );
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

  /** Assigned, not yet collected deliveries whose pickup clock is running. */
  async findAwaitingPickup() {
    return Delivery.find({
      status: 'assigned_to_driver',
      driver_id: { $ne: null },
      pickup_due_at: { $ne: null },
      'late_pickup.flagged_at': null,
    }).lean();
  }

  /** Unassigned deliveries whose kitchen is still cooking or that are ready. */
  async findOpenForDispatch(statuses) {
    return Delivery.find({ status: { $in: statuses }, driver_id: null }).lean();
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
            // Deliveries finished with the customer's code only had
            // completed_at until delivered_at was set there too.
            $or: [
              { delivered_at: { $gte: start, $lt: end } },
              { delivered_at: null, completed_at: { $gte: start, $lt: end } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            // What the driver was actually paid (the promised fee minus a
            // late-pickup penalty); older deliveries have no `paid_earnings`.
            earnings: { $sum: { $ifNull: ['$paid_earnings_rwf', '$promised_earnings_rwf'] } },
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
            earnings: { $sum: { $ifNull: ['$paid_earnings_rwf', '$promised_earnings_rwf'] } },
          },
        },
      ]),
    ]);

    return {
      today: today[0] || { count: 0, earnings: 0 },
      total: allTime[0] || { count: 0, earnings: 0 },
    };
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ statuses, driverId, vendorId, limit, offset }) {
    const filter = {};
    if (statuses && statuses.length > 0) filter.status = { $in: statuses };
    if (driverId) filter.driver_id = driverId;
    if (vendorId) filter.vendor_id = vendorId;

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

  async countActive(activeStatuses) {
    return Delivery.countDocuments({ status: { $in: activeStatuses } });
  }

  async countsByStatus() {
    const rows = await Delivery.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});
  }

  async findByDriver(driverId, statuses) {
    return Delivery.find({ driver_id: driverId, status: { $in: statuses } }).lean();
  }

  async handback(deliveryId, { status, note }) {
    return Delivery.findOneAndUpdate(
      { _id: deliveryId },
      {
        $set: {
          status,
          driver_id: null,
          assigned_at: null,
          // The next worker starts their own pickup clock.
          pickup_started_at: null,
          pickup_warn_at: null,
          pickup_due_at: null,
          pickup_reassign_at: null,
          // A late record belongs to the worker who was late.
          'late_pickup.warned_at': null,
          'late_pickup.flagged_at': null,
          'late_pickup.minutes_late': null,
          'late_pickup.charge_status': 'none',
          'late_pickup.charge_rwf': null,
          'late_pickup.penalty_percent': null,
        },
        $push: {
          status_history: { status, at: new Date(), note: note || 'Reassigned by admin', by: 'admin' },
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }
}

module.exports = new DeliveryRepository();

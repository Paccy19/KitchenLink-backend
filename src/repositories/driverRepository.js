const mongoose = require('mongoose');
const { Driver } = require('../models');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toPoint = ({ lat, lng }) => ({
  type: 'Point',
  coordinates: [lng, lat],
});

class DriverRepository {
  async create(doc) {
    const driver = await Driver.create(doc);
    return driver.toObject();
  }

  async findById(driverId) {
    return Driver.findOne({ _id: driverId, deleted_at: null }).lean();
  }

  async findByPhone(phone) {
    return Driver.findOne({ phone, deleted_at: null }).lean();
  }

  /** Includes removed accounts: the unique email index still covers them. */
  async findByEmail(email) {
    return Driver.findOne({ email }).lean();
  }

  /** Used only by password change flows; includes the password hash. */
  async findByIdWithPassword(driverId) {
    return Driver.findOne({ _id: driverId, deleted_at: null })
      .select('+password_hash')
      .lean();
  }

  async update(driverId, update) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async touchLogin(driverId) {
    await Driver.updateOne(
      { _id: driverId },
      { $set: { last_login_at: new Date() } }
    );
  }

  async setLocation(driverId, { lat, lng, heading = null, speedMps = null, accuracyM = null }) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      {
        $set: {
          location: toPoint({ lat, lng }),
          location_updated_at: new Date(),
          location_heading: heading,
          location_speed_mps: speedMps,
          location_accuracy_m: accuracyM,
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  async setAvailability(driverId, { isOnline, status }) {
    const update = {};
    if (isOnline !== undefined) {
      update.is_online = isOnline;
      update.is_available = isOnline;
    }
    if (status !== undefined) update.status = status;
    return this.update(driverId, update);
  }

  async incrementActive(driverId) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      { $inc: { active_deliveries_count: 1 } },
      { returnDocument: 'after' }
    ).lean();
  }

  async decrementActive(driverId) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      { $inc: { active_deliveries_count: -1 } },
      { returnDocument: 'after' }
    ).lean();
  }

  async recordCompletion(driverId, { earningsRwf = 0 }) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      {
        $inc: {
          completed_deliveries: 1,
          total_earnings_rwf: earningsRwf,
          available_balance_rwf: earningsRwf,
          active_deliveries_count: -1,
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  /**
   * Online + available drivers within radius of a pickup point, ranked by
   * proximity. Used by the dispatch matching algorithm.
   */
  async findNearbyAvailable({ coords, radiusKm, excludeDriverIds = [], limit = 20, locationSince = null }) {
    const query = {
      is_active: true,
      is_online: true,
      is_available: true,
      deleted_at: null,
    };
    // Only positions reported recently: an old (or never-shared, city-centre
    // default) position says nothing about where the driver is now.
    if (locationSince) query.location_updated_at = { $gte: locationSince };
    if (excludeDriverIds.length > 0) {
      // Aggregation queries don't cast strings to ObjectIds, so cast here or
      // nobody would be excluded.
      query._id = { $nin: excludeDriverIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
    }

    const pipeline = [
      {
        $geoNear: {
          near: toPoint(coords),
          distanceField: 'distance_m',
          maxDistance: radiusKm * 1000,
          spherical: true,
          key: 'location',
          query,
        },
      },
      { $set: { distance_km: { $divide: ['$distance_m', 1000] } } },
      { $unset: 'distance_m' },
      { $sort: { distance_km: 1, active_deliveries_count: 1, rating: -1 } },
      { $limit: limit },
    ];

    return Driver.aggregate(pipeline).allowDiskUse(true);
  }

  async list({ limit, offset, sort = 'newest' }) {
    const sortSpec =
      { rating: { rating: -1 }, deliveries: { completed_deliveries: -1 } }[sort] ||
      { created_at: -1 };
    const [drivers, total] = await Promise.all([
      Driver.find({ deleted_at: null }).sort(sortSpec).skip(offset).limit(limit).lean(),
      Driver.countDocuments({ deleted_at: null }),
    ]);
    return { drivers, total };
  }

  async earnings(driverId) {
    const [result] = await Driver.aggregate([
      { $match: { _id: new (require('mongoose').Types.ObjectId)(String(driverId)) } },
      {
        $project: {
          completed_deliveries: 1,
          total_earnings_rwf: 1,
          rating: 1,
          rating_count: 1,
        },
      },
    ]);
    return result || {};
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ status, online, search, limit, offset }) {
    const filter = { deleted_at: null };
    if (status) filter.verification_status = status;
    if (online !== undefined) filter.is_online = online;
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { plate_number: regex },
      ];
    }

    const [drivers, total] = await Promise.all([
      Driver.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      Driver.countDocuments(filter),
    ]);
    return { drivers, total };
  }

  async countsByVerification() {
    const rows = await Driver.aggregate([
      { $match: { deleted_at: null } },
      { $group: { _id: '$verification_status', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});
  }

  async countActive() {
    return Driver.countDocuments({ is_active: true, deleted_at: null });
  }

  async countOnline() {
    return Driver.countDocuments({ is_online: true, deleted_at: null });
  }

  async countSince(date) {
    return Driver.countDocuments({ created_at: { $gte: date }, deleted_at: null });
  }

  /* ------------------------------ wallet ------------------------------ */

  /** Reserve funds for a withdrawal; null when the balance is too low. */
  async decrementBalance(driverId, amountRwf) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null, available_balance_rwf: { $gte: amountRwf } },
      { $inc: { available_balance_rwf: -amountRwf } },
      { returnDocument: 'after' }
    ).lean();
  }

  /** Total the platform owes riders (their unwithdrawn balances). */
  async totalBalances() {
    const [row] = await Driver.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ['$available_balance_rwf', 0] } } } }]);
    return row?.total ?? 0;
  }

  /** Return funds to the balance (e.g. a failed payout). */
  async incrementBalance(driverId, amountRwf) {
    return Driver.findOneAndUpdate(
      { _id: driverId },
      { $inc: { available_balance_rwf: amountRwf } },
      { returnDocument: 'after' }
    ).lean();
  }

  async listBalances({ limit, offset }) {
    const [drivers, total] = await Promise.all([
      Driver.find({ deleted_at: null })
        .sort({ available_balance_rwf: -1, total_earnings_rwf: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Driver.countDocuments({ deleted_at: null }),
    ]);
    return { drivers, total };
  }

  /**
   * One-off backfill for drivers created before withdrawals existed: their
   * whole earnings history is still unpaid, so it becomes their balance.
   */
  async backfillAvailableBalances() {
    const result = await Driver.updateMany(
      { available_balance_rwf: { $exists: false } },
      [{ $set: { available_balance_rwf: { $ifNull: ['$total_earnings_rwf', 0] } } }],
      { updatePipeline: true }
    );
    return result.modifiedCount ?? 0;
  }

  async setVerification(driverId, update) {
    return this.update(driverId, update);
  }
}

module.exports = new DriverRepository();

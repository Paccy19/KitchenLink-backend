const { Driver } = require('../models');

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
      { new: true }
    ).lean();
  }

  async touchLogin(driverId) {
    await Driver.updateOne(
      { _id: driverId },
      { $set: { last_login_at: new Date() } }
    );
  }

  async setLocation(driverId, { lat, lng }) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      {
        $set: {
          location: toPoint({ lat, lng }),
          location_updated_at: new Date(),
        },
      },
      { new: true }
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
      { new: true }
    ).lean();
  }

  async decrementActive(driverId) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      { $inc: { active_deliveries_count: -1 } },
      { new: true }
    ).lean();
  }

  async recordCompletion(driverId, { earningsRwf = 0 }) {
    return Driver.findOneAndUpdate(
      { _id: driverId, deleted_at: null },
      {
        $inc: {
          completed_deliveries: 1,
          total_earnings_rwf: earningsRwf,
          active_deliveries_count: -1,
        },
      },
      { new: true }
    ).lean();
  }

  /**
   * Online + available drivers within radius of a pickup point, ranked by
   * proximity. Used by the dispatch matching algorithm.
   */
  async findNearbyAvailable({ coords, radiusKm, excludeDriverIds = [], limit = 20 }) {
    const query = {
      is_active: true,
      is_online: true,
      is_available: true,
      deleted_at: null,
    };
    if (excludeDriverIds.length > 0) {
      query._id = { $nin: excludeDriverIds };
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
}

module.exports = new DriverRepository();

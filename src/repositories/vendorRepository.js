const { Vendor } = require('../models');

const toPoint = ({ lat, lng }) => ({
  type: 'Point',
  coordinates: [lng, lat],
});

class VendorRepository {
  /**
   * Active vendors within radius, with distance_km populated.
   * Falls back to rating order when no coordinates are available.
   */
  async findNearby({
    coords,
    radiusKm,
    categoryVendorIds = null,
    sort = 'distance',
    limit,
    offset = 0,
  }) {
    const baseQuery = { is_active: true, deleted_at: null };
    if (categoryVendorIds) baseQuery._id = { $in: categoryVendorIds };

    let pipeline;

    if (coords) {
      pipeline = [
        {
          $geoNear: {
            near: toPoint(coords),
            distanceField: 'distance_m',
            maxDistance: radiusKm * 1000,
            spherical: true,
            key: 'location',
            query: baseQuery,
          },
        },
        { $set: { distance_km: { $divide: ['$distance_m', 1000] } } },
        { $unset: 'distance_m' },
      ];
    } else {
      pipeline = [{ $match: baseQuery }];
    }

    const sortSpec =
      coords && sort === 'distance'
        ? { distance_km: 1 }
        : { rating: -1, distance_km: 1, name: 1 };

    pipeline.push({
      $facet: {
        items: [{ $sort: sortSpec }, { $skip: offset }, { $limit: limit }],
        total: [{ $count: 'value' }],
      },
    });

    const [result] = await Vendor.aggregate(pipeline).allowDiskUse(true);
    return {
      vendors: result.items,
      total: result.total[0]?.value ?? 0,
    };
  }

  async findById(vendorId) {
    return Vendor.findOne({ _id: vendorId, deleted_at: null }).lean();
  }

  async findActiveById(vendorId) {
    return Vendor.findOne({ _id: vendorId, is_active: true, deleted_at: null }).lean();
  }

  /** Used only by the vendor login flow; includes the password hash. */
  async findByEmailWithPassword(email) {
    return Vendor.findOne({ email, deleted_at: null })
      .select('+password_hash')
      .lean();
  }

  async findByPhone(phone) {
    return Vendor.findOne({ phone, deleted_at: null }).lean();
  }

  async create(doc) {
    const vendor = await Vendor.create(doc);
    return vendor.toObject();
  }

  async update(vendorId, update) {
    return Vendor.findOneAndUpdate(
      { _id: vendorId, deleted_at: null },
      { $set: update },
      { new: true }
    ).lean();
  }

  async touchLogin(vendorId) {
    await Vendor.updateOne(
      { _id: vendorId },
      { $set: { last_login_at: new Date() } }
    );
  }

  async incrementSales(vendorId, { totalRwf = 0, balanceRwf = 0 }) {
    return Vendor.findOneAndUpdate(
      { _id: vendorId, deleted_at: null },
      { $inc: { total_sales: totalRwf, available_balance: balanceRwf } },
      { new: true }
    ).lean();
  }

  async softDelete(vendorId) {
    return Vendor.findOneAndUpdate(
      { _id: vendorId, deleted_at: null },
      { $set: { deleted_at: new Date(), is_active: false } },
      { new: true }
    ).lean();
  }

  async findTopRated(limit) {
    return Vendor.find({ is_active: true, deleted_at: null })
      .sort({ rating: -1, estimated_prep_time: 1, name: 1 })
      .limit(limit)
      .lean();
  }

  /**
   * Vendors whose name (or neighborhood) fuzzy-matches the tokens,
   * or that own a dish matching the tokens. Limited candidate set;
   * final relevance ranking happens in the service layer.
   */
  async search({ tokenFilter, dishVendorIds = [], limit }) {
    const orClauses = [tokenFilter];
    if (dishVendorIds.length > 0) {
      orClauses.push({ _id: { $in: dishVendorIds } });
    }

    return Vendor.find({
      is_active: true,
      deleted_at: null,
      $or: orClauses,
    })
      .sort({ rating: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new VendorRepository();

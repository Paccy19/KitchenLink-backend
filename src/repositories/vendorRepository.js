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
    const baseQuery = { is_active: true };
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
    return Vendor.findById(vendorId).lean();
  }

  async findActiveById(vendorId) {
    return Vendor.findOne({ _id: vendorId, is_active: true }).lean();
  }

  async findTopRated(limit) {
    return Vendor.find({ is_active: true })
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
      $or: orClauses,
    })
      .sort({ rating: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new VendorRepository();

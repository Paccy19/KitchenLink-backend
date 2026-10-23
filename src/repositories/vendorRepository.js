const { Vendor } = require('../models');
const { liveVendorFilter, liveVendorExpr } = require('../utils/vendorPresence');

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Narrows a query to the given vendor type codes (no-op when none). */
const withVendorTypes = (query, vendorTypes) => {
  if (vendorTypes && vendorTypes.length) query.vendor_type = { $in: vendorTypes };
  return query;
};

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
    vendorTypes = null,
    sort = 'distance',
    limit,
    offset = 0,
  }) {
    const baseQuery = withVendorTypes({ is_active: true, deleted_at: null, ...liveVendorFilter() }, vendorTypes);
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

  /**
   * Every open (live) kitchen for the customer map, at any distance. With
   * coordinates each one gets distance_km and they come nearest first;
   * otherwise best rated first. `limit` is a safety cap, not a page size.
   */
  async findOpenForMap({ coords, categoryVendorIds = null, vendorTypes = null, limit }) {
    const baseQuery = withVendorTypes({ is_active: true, deleted_at: null, ...liveVendorFilter() }, vendorTypes);
    if (categoryVendorIds) baseQuery._id = { $in: categoryVendorIds };

    const pipeline = coords
      ? [
          {
            $geoNear: {
              near: toPoint(coords),
              distanceField: 'distance_m',
              spherical: true,
              key: 'location',
              query: baseQuery,
            },
          },
          { $set: { distance_km: { $divide: ['$distance_m', 1000] } } },
          { $unset: 'distance_m' },
          { $sort: { distance_km: 1 } },
        ]
      : [{ $match: baseQuery }, { $sort: { rating: -1, name: 1 } }];
    pipeline.push({
      $facet: {
        items: [{ $limit: limit }],
        total: [{ $count: 'value' }],
      },
    });

    const [result] = await Vendor.aggregate(pipeline).allowDiskUse(true);
    return {
      vendors: result.items,
      total: result.total[0]?.value ?? 0,
    };
  }

  /**
   * Every active kitchen, open or closed, near or far. With coordinates the
   * kitchens within `nearRadiusKm` come first (open before closed), then the
   * rest; each group nearest first. `sort: 'rating'` orders by rating instead.
   */
  async findAll({
    coords,
    nearRadiusKm,
    categoryVendorIds = null,
    vendorTypes = null,
    sort = 'distance',
    limit,
    offset = 0,
  }) {
    const baseQuery = withVendorTypes({ is_active: true, deleted_at: null }, vendorTypes);
    if (categoryVendorIds) baseQuery._id = { $in: categoryVendorIds };

    const pipeline = coords
      ? [
          {
            $geoNear: {
              near: toPoint(coords),
              distanceField: 'distance_m',
              spherical: true,
              key: 'location',
              query: baseQuery,
            },
          },
          { $set: { distance_km: { $divide: ['$distance_m', 1000] } } },
          { $unset: 'distance_m' },
          { $set: { is_nearby: { $lte: ['$distance_km', nearRadiusKm] } } },
        ]
      : [{ $match: baseQuery }, { $set: { is_nearby: false } }];
    pipeline.push({ $set: { is_live: liveVendorExpr() } });

    const sortSpec =
      sort === 'rating'
        ? { is_live: -1, rating: -1, name: 1 }
        : coords
          ? { is_nearby: -1, is_live: -1, distance_km: 1 }
          : { is_live: -1, rating: -1, name: 1 };

    pipeline.push({
      $facet: {
        items: [{ $sort: sortSpec }, { $skip: offset }, { $limit: limit }],
        total: [{ $count: 'value' }],
        nearby: [{ $match: { is_nearby: true } }, { $count: 'value' }],
      },
    });

    const [result] = await Vendor.aggregate(pipeline).allowDiskUse(true);
    return {
      vendors: result.items,
      total: result.total[0]?.value ?? 0,
      nearbyTotal: result.nearby[0]?.value ?? 0,
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

  /** Includes removed accounts: the unique email index still covers them. */
  async findByEmail(email) {
    return Vendor.findOne({ email }).lean();
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

  /** Atomically reserves funds; returns null when the balance is insufficient. */
  async decrementBalance(vendorId, amountRwf) {
    return Vendor.findOneAndUpdate(
      {
        _id: vendorId,
        deleted_at: null,
        available_balance: { $gte: amountRwf },
      },
      { $inc: { available_balance: -amountRwf } },
      { new: true }
    ).lean();
  }

  /** Total the platform owes vendors (their unwithdrawn balances). */
  async totalBalances() {
    const [row] = await Vendor.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ['$available_balance', 0] } } } }]);
    return row?.total ?? 0;
  }

  /** Return funds to the balance (e.g. a failed payout). */
  async incrementBalance(vendorId, amountRwf) {
    return Vendor.findOneAndUpdate(
      { _id: vendorId },
      { $inc: { available_balance: amountRwf } },
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

  async findTopRated(limit, { vendorTypes = null } = {}) {
    return Vendor.find(withVendorTypes({ is_active: true, deleted_at: null, ...liveVendorFilter() }, vendorTypes))
      .sort({ rating: -1, estimated_prep_time: 1, name: 1 })
      .limit(limit)
      .lean();
  }

  /** Active vendors with an orderable "Tomorrow's Special", soonest first. */
  async findActiveSpecials(limit = 30) {
    return Vendor.find({
      is_active: true,
      deleted_at: null,
      'special.is_active': true,
      'special.cutoff_at': { $gt: new Date() },
    })
      .sort({ 'special.delivery_at': 1, rating: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Vendors whose name (or neighborhood) fuzzy-matches the tokens,
   * or that own a dish matching the tokens. Limited candidate set;
   * final relevance ranking happens in the service layer.
   */
  async search({ tokenFilter, dishVendorIds = [], vendorTypes = null, limit }) {
    const orClauses = [tokenFilter];
    if (dishVendorIds.length > 0) {
      orClauses.push({ _id: { $in: dishVendorIds } });
    }

    // Closed kitchens are searchable too (customers can schedule for later);
    // the search service ranks open ones higher.
    return Vendor.find(
      withVendorTypes(
        {
          is_active: true,
          deleted_at: null,
          $or: orClauses,
        },
        vendorTypes
      )
    )
      .sort({ rating: -1 })
      .limit(limit)
      .lean();
  }

  /* ------------------------------- admin ------------------------------- */

  async adminList({ status, search, isActive, vendorTypes = null, limit, offset }) {
    const filter = withVendorTypes({ deleted_at: null }, vendorTypes);
    if (status) filter.verification_status = status;
    if (isActive !== undefined) filter.is_active = isActive;
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: regex },
        { owner_name: regex },
        { phone: regex },
        { email: regex },
        { neighborhood: regex },
      ];
    }

    const [vendors, total] = await Promise.all([
      Vendor.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
      Vendor.countDocuments(filter),
    ]);
    return { vendors, total };
  }

  /**
   * Admin grouping: how many vendors of each type, optionally within one
   * verification status (pending / approved / suspended …).
   */
  async countsByType({ status = null } = {}) {
    const match = { deleted_at: null };
    if (status) match.verification_status = status;
    const rows = await Vendor.aggregate([
      { $match: match },
      { $group: { _id: '$vendor_type', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id || 'other'] = row.count;
      return acc;
    }, {});
  }

  async countsByVerification() {
    const rows = await Vendor.aggregate([
      { $match: { deleted_at: null } },
      { $group: { _id: '$verification_status', count: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});
  }

  async countActive() {
    return Vendor.countDocuments({ is_active: true, deleted_at: null });
  }

  async countSince(date) {
    return Vendor.countDocuments({ created_at: { $gte: date }, deleted_at: null });
  }

  async platformTotals() {
    const [row] = await Vendor.aggregate([
      { $match: { deleted_at: null } },
      {
        $group: {
          _id: null,
          total_sales: { $sum: '$total_sales' },
          available_balance: { $sum: '$available_balance' },
        },
      },
    ]);
    return row || { total_sales: 0, available_balance: 0 };
  }

  async listBalances({ sort = 'balance', limit, offset }) {
    const sortSpec =
      sort === 'sales' ? { total_sales: -1 } : { available_balance: -1 };
    const [vendors, total] = await Promise.all([
      Vendor.find({ deleted_at: null })
        .sort(sortSpec)
        .skip(offset)
        .limit(limit)
        .lean(),
      Vendor.countDocuments({ deleted_at: null }),
    ]);
    return { vendors, total };
  }
}

module.exports = new VendorRepository();

const { Commission } = require('../models');

class CommissionRepository {
  async create(doc) {
    const commission = await Commission.create(doc);
    return commission.toObject();
  }

  async findById(commissionId) {
    return Commission.findOne({ _id: commissionId, deleted_at: null }).lean();
  }

  async update(commissionId, update) {
    return Commission.findOneAndUpdate(
      { _id: commissionId, deleted_at: null },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async softDelete(commissionId) {
    return Commission.findOneAndUpdate(
      { _id: commissionId, deleted_at: null },
      { $set: { deleted_at: new Date(), is_active: false } },
      { returnDocument: 'after' }
    ).lean();
  }

  async list({ scope, isActive, limit, offset }) {
    const filter = { deleted_at: null };
    if (scope) filter.scope = scope;
    if (isActive !== undefined) filter.is_active = isActive;

    const [commissions, total] = await Promise.all([
      Commission.find(filter)
        .sort({ scope: 1, created_at: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Commission.countDocuments(filter),
    ]);

    return { commissions, total };
  }

  /**
   * Resolve the commission config that applies to an order context. The most
   * specific active scope wins: vendor > category > vendor_type > global.
   */
  async findApplicable({ vendorId, categoryId, vendorType }) {
    const or = [{ scope: 'global' }];
    if (vendorId) or.push({ scope: 'vendor', vendor_id: vendorId });
    if (categoryId) or.push({ scope: 'category', category_id: categoryId });
    if (vendorType) or.push({ scope: 'vendor_type', vendor_type: vendorType });

    const rows = await Commission.find({
      deleted_at: null,
      is_active: true,
      $or: or,
    }).lean();

    const rank = { vendor: 3, category: 2, vendor_type: 1, global: 0 };
    return rows.sort((a, b) => (rank[b.scope] || 0) - (rank[a.scope] || 0))[0] || null;
  }

  async findGlobal() {
    return Commission.findOne({
      deleted_at: null,
      is_active: true,
      scope: 'global',
    })
      .sort({ created_at: -1 })
      .lean();
  }
}

module.exports = new CommissionRepository();

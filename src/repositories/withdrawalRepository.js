const { Withdrawal } = require('../models');

class WithdrawalRepository {
  async create(doc) {
    const withdrawal = await Withdrawal.create(doc);
    return withdrawal.toObject();
  }

  async listByVendor(vendorId, { limit = 50 } = {}) {
    return Withdrawal.find({ vendor_id: vendorId, deleted_at: null })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
  }

  /** Total reserved/paid out (excludes failed requests). */
  async totalWithdrawn(vendorId) {
    const [result] = await Withdrawal.aggregate([
      {
        $match: {
          vendor_id: vendorId,
          deleted_at: null,
          status: { $in: ['processing', 'completed'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount_rwf' } } },
    ]);
    return result?.total ?? 0;
  }

  /* ------------------------------- admin ------------------------------- */

  async findById(withdrawalId) {
    return Withdrawal.findOne({ _id: withdrawalId, deleted_at: null }).lean();
  }

  async adminList({ status, vendorId, limit, offset }) {
    const filter = { deleted_at: null };
    if (status) filter.status = status;
    if (vendorId) filter.vendor_id = vendorId;

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('vendor_id', 'name phone neighborhood')
        .lean(),
      Withdrawal.countDocuments(filter),
    ]);
    return { withdrawals, total };
  }

  async updateStatus(withdrawalId, update) {
    return Withdrawal.findOneAndUpdate(
      { _id: withdrawalId, deleted_at: null },
      { $set: update },
      { new: true }
    ).lean();
  }

  async totalsByStatus() {
    const rows = await Withdrawal.aggregate([
      { $match: { deleted_at: null } },
      { $group: { _id: '$status', total: { $sum: '$amount_rwf' }, count: { $sum: 1 } } },
    ]);
    return rows;
  }
}

module.exports = new WithdrawalRepository();

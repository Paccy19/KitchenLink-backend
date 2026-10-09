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
}

module.exports = new WithdrawalRepository();

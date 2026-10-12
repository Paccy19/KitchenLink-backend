const { PlatformWithdrawal } = require('../models');

class PlatformWithdrawalRepository {
  async create(doc) {
    const withdrawal = await PlatformWithdrawal.create(doc);
    return withdrawal.toObject();
  }

  async findById(withdrawalId) {
    return PlatformWithdrawal.findById(withdrawalId).lean();
  }

  async list({ limit = 50 } = {}) {
    return PlatformWithdrawal.find({}).sort({ created_at: -1 }).limit(limit).lean();
  }

  async findProcessing() {
    return PlatformWithdrawal.findOne({ status: 'processing' }).lean();
  }

  async sum(filter = {}) {
    const [row] = await PlatformWithdrawal.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$amount_rwf' } } },
    ]);
    return row?.total ?? 0;
  }

  /** Requested or paid since `since` (counts toward the weekly limit). */
  async totalSince(since) {
    return this.sum({ status: { $in: ['processing', 'completed'] }, created_at: { $gte: since } });
  }

  /** Atomically finalizes a request that is still processing (exactly once). */
  async finalizeProcessing(withdrawalId, update) {
    return PlatformWithdrawal.findOneAndUpdate(
      { _id: withdrawalId, status: 'processing' },
      { $set: update },
      { new: true }
    ).lean();
  }
}

module.exports = new PlatformWithdrawalRepository();

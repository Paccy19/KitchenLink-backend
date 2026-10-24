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

  async listByDriver(driverId, { limit = 50 } = {}) {
    return Withdrawal.find({ driver_id: driverId, payee_type: 'driver', deleted_at: null })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
  }

  /** Total reserved/paid out (excludes failed requests). */
  async totalWithdrawn(vendorId) {
    return this.#sumByStatus({ vendor_id: vendorId }, ['processing', 'completed']);
  }

  async totalWithdrawnByDriver(driverId) {
    return this.#sumByStatus({ driver_id: driverId, payee_type: 'driver' }, ['processing', 'completed']);
  }

  /** Requested but not yet paid: still owed, just reserved. */
  async totalProcessing(payeeType) {
    const owner = payeeType === 'driver' ? { payee_type: 'driver' } : { payee_type: { $ne: 'driver' } };
    return this.#sumByStatus(owner, ['processing']);
  }

  async totalProcessingByDriver(driverId) {
    return this.#sumByStatus({ driver_id: driverId, payee_type: 'driver' }, ['processing']);
  }

  async #sumByStatus(owner, statuses) {
    const [result] = await Withdrawal.aggregate([
      { $match: { ...owner, deleted_at: null, status: { $in: statuses } } },
      { $group: { _id: null, total: { $sum: '$amount_rwf' } } },
    ]);
    return result?.total ?? 0;
  }

  /* ------------------------------- admin ------------------------------- */

  async findById(withdrawalId) {
    return Withdrawal.findOne({ _id: withdrawalId, deleted_at: null }).lean();
  }

  async adminList({ status, payeeType, vendorId, driverId, limit, offset }) {
    const filter = { deleted_at: null };
    if (status) filter.status = status;
    if (payeeType === 'driver') filter.payee_type = 'driver';
    // Legacy vendor withdrawals predate `payee_type`.
    if (payeeType === 'vendor') filter.payee_type = { $ne: 'driver' };
    if (vendorId) filter.vendor_id = vendorId;
    if (driverId) filter.driver_id = driverId;

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .populate('vendor_id', 'name phone neighborhood payment_information')
        .populate('driver_id', 'name phone vehicle_type plate_number')
        .lean(),
      Withdrawal.countDocuments(filter),
    ]);
    return { withdrawals, total };
  }

  async findByIdPopulated(withdrawalId) {
    return Withdrawal.findOne({ _id: withdrawalId, deleted_at: null })
      .populate('vendor_id', 'name phone neighborhood payment_information')
      .populate('driver_id', 'name phone vehicle_type plate_number')
      .lean();
  }

  async updateStatus(withdrawalId, update) {
    return Withdrawal.findOneAndUpdate(
      { _id: withdrawalId, deleted_at: null },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  /**
   * Atomically finalizes a request that is still `processing`. Returns null if
   * it was already finalized, so a payout can never be paid or refunded twice.
   */
  async finalizeProcessing(withdrawalId, update) {
    return Withdrawal.findOneAndUpdate(
      { _id: withdrawalId, deleted_at: null, status: 'processing' },
      { $set: update },
      { returnDocument: 'after' }
    ).lean();
  }

  async totalsByStatus({ payeeType } = {}) {
    const match = { deleted_at: null };
    if (payeeType === 'driver') match.payee_type = 'driver';
    if (payeeType === 'vendor') match.payee_type = { $ne: 'driver' };
    const rows = await Withdrawal.aggregate([
      { $match: match },
      { $group: { _id: '$status', total: { $sum: '$amount_rwf' }, count: { $sum: 1 } } },
    ]);
    return rows;
  }
}

module.exports = new WithdrawalRepository();

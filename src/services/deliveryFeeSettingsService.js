const { DeliveryFeeSettings } = require('../models');
const { parseDistanceFeeRanges, rangeForDistance } = require('../utils/distanceFeeRanges');

// No delivery fee may ever be below this.
const MIN_FEE_RWF = 500;
const MAX_FEE_RWF = 100000;
const MAX_KM = 500;

/**
 * Delivery fee by distance ranges, set by admins. Ranges are kept sorted and
 * must start at 0 km, follow each other with no gaps or overlaps, and end with
 * an open range ("6 km and more") so every distance has a price. Until an
 * admin saves ranges, the formula in config is used (see deliveryPricingService).
 */
class DeliveryFeeSettingsService {
  #ranges = [];
  #updatedAt = null;

  async load() {
    const row = await DeliveryFeeSettings.findOne({ key: 'primary' }).lean();
    this.#ranges = (row?.ranges || []).map((range) => ({
      from_km: range.from_km,
      to_km: range.to_km ?? null,
      fee_rwf: range.fee_rwf,
    }));
    this.#updatedAt = row?.updated_at ?? null;
    return this.current();
  }

  current() {
    return { ranges: this.#ranges, min_fee_rwf: MIN_FEE_RWF, updated_at: this.#updatedAt };
  }

  /** The admin's fee for this distance, or null when no ranges are set. */
  feeFor(distanceKm) {
    const range = rangeForDistance(this.#ranges, distanceKm);
    return range ? Math.max(MIN_FEE_RWF, range.fee_rwf) : null;
  }

  async update(admin, body = {}) {
    // An empty list goes back to the standard formula.
    const ranges = parseDistanceFeeRanges(body.ranges, { minFee: MIN_FEE_RWF, maxFee: MAX_FEE_RWF, maxKm: MAX_KM });

    const previous = this.current();
    await DeliveryFeeSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { ranges, updated_by: admin?._id || null } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    await this.load();
    return { previous, current: this.current() };
  }
}

module.exports = new DeliveryFeeSettingsService();
module.exports.MIN_FEE_RWF = MIN_FEE_RWF;

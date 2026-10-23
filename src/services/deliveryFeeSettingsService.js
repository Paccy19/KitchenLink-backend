const ApiError = require('../utils/ApiError');
const { DeliveryFeeSettings } = require('../models');

// No delivery fee may ever be below this.
const MIN_FEE_RWF = 500;
const MAX_FEE_RWF = 100000;
const MAX_KM = 500;

const roundKm = (value) => Math.round(Number(value) * 10) / 10;

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
    if (!this.#ranges.length) return null;
    const km = Math.max(0, Number(distanceKm) || 0);
    const range =
      this.#ranges.find((entry) => km >= entry.from_km && (entry.to_km === null || km < entry.to_km)) ||
      this.#ranges[this.#ranges.length - 1];
    return Math.max(MIN_FEE_RWF, range.fee_rwf);
  }

  async update(admin, body = {}) {
    if (!Array.isArray(body.ranges)) {
      throw ApiError.badRequest('ranges is required.', { ranges: 'expected a list of distance ranges' });
    }
    // An empty list goes back to the standard formula.
    const ranges = body.ranges.map((raw, index) => {
      const label = `Range ${index + 1}`;
      const from = roundKm(raw?.from_km);
      const to = raw?.to_km === null || raw?.to_km === '' || raw?.to_km === undefined ? null : roundKm(raw.to_km);
      const fee = Number(raw?.fee_rwf);
      if (!Number.isFinite(from) || from < 0 || from > MAX_KM) {
        throw ApiError.badRequest(`${label}: the start must be between 0 and ${MAX_KM} km.`, { ranges: 'invalid from_km' });
      }
      if (to !== null && (!Number.isFinite(to) || to <= from || to > MAX_KM)) {
        throw ApiError.badRequest(`${label}: the end must be more than the start (${from} km).`, { ranges: 'invalid to_km' });
      }
      if (!Number.isInteger(fee) || fee < MIN_FEE_RWF || fee > MAX_FEE_RWF) {
        throw ApiError.badRequest(
          `${label}: the fee must be a whole number of at least ${MIN_FEE_RWF} RWF (and at most ${MAX_FEE_RWF.toLocaleString('en-US')} RWF).`,
          { ranges: `fee_rwf must be ${MIN_FEE_RWF}-${MAX_FEE_RWF}` }
        );
      }
      return { from_km: from, to_km: to, fee_rwf: fee };
    });
    ranges.sort((a, b) => a.from_km - b.from_km);

    if (ranges.length) {
      if (ranges[0].from_km !== 0) {
        throw ApiError.badRequest('The first range must start at 0 km.', { ranges: 'must start at 0 km' });
      }
      for (let i = 0; i < ranges.length - 1; i += 1) {
        const current = ranges[i];
        const next = ranges[i + 1];
        if (current.to_km === null) {
          throw ApiError.badRequest('Only the last range can be open-ended ("and more").', { ranges: 'open range must be last' });
        }
        if (next.from_km !== current.to_km) {
          throw ApiError.badRequest(
            next.from_km > current.to_km
              ? `Gap between ${current.to_km} km and ${next.from_km} km: every distance needs a fee.`
              : `Ranges overlap around ${next.from_km} km.`,
            { ranges: 'ranges must follow each other' }
          );
        }
      }
      if (ranges[ranges.length - 1].to_km !== null) {
        throw ApiError.badRequest(
          `The last range must have no end ("${ranges[ranges.length - 1].from_km} km and more") so every distance has a fee.`,
          { ranges: 'last range must be open-ended' }
        );
      }
    }

    const previous = this.current();
    await DeliveryFeeSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { ranges, updated_by: admin?._id || null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await this.load();
    return { previous, current: this.current() };
  }
}

module.exports = new DeliveryFeeSettingsService();
module.exports.MIN_FEE_RWF = MIN_FEE_RWF;

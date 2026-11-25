const config = require('../config');
const { BigEventDeliverySettings } = require('../models');
const { parseBigEventDeliverySettings, bigEventDeliveryFee } = require('../utils/bigEventDeliveryPricing');

/** Starting values (config.delivery.bigEvent / BIG_EVENT_DELIVERY_* in .env) until an admin saves. */
const defaults = () => {
  const be = config.delivery.bigEvent;
  const starting = Math.round(be.startingFeeRwf);
  return {
    enabled: true,
    starting_fee_rwf: starting,
    per_meter_rwf: Math.round(be.perMeterRwf * 1000) / 1000,
    min_fee_rwf: Math.round(be.minFeeRwf),
    auto_ceiling_rwf: Math.max(starting, Math.round(be.autoCeilingRwf)),
    quotation_validity_hours: Math.round(be.quotationValidityHours),
  };
};

const FIELDS = ['enabled', 'starting_fee_rwf', 'per_meter_rwf', 'min_fee_rwf', 'auto_ceiling_rwf', 'quotation_validity_hours'];

/**
 * The admin's big-event delivery pricing (Delivery Management → Big-event
 * delivery). Loaded at start-up and kept in memory; vendors can never change
 * it. Only big-event orders the kitchen delivers use it.
 */
class BigEventDeliverySettingsService {
  #saved = null;
  #updatedAt = null;

  async load() {
    const row = await BigEventDeliverySettings.findOne({ key: 'primary' }).lean();
    this.#saved = row ? Object.fromEntries(FIELDS.map((field) => [field, row[field]])) : null;
    this.#updatedAt = row?.updated_at ?? null;
    return this.current();
  }

  settings() {
    return this.#saved ? { ...defaults(), ...this.#saved } : defaults();
  }

  current() {
    return { ...this.settings(), saved: Boolean(this.#saved), updated_at: this.#updatedAt };
  }

  /** The automatic fee for these road meters (see bigEventDeliveryFee). */
  feeFor(distanceM) {
    const settings = this.settings();
    return { ...bigEventDeliveryFee(distanceM, settings), settings };
  }

  async update(admin, body = {}) {
    const values = parseBigEventDeliverySettings(body);
    const previous = this.current();
    await BigEventDeliverySettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { ...values, updated_by: admin?._id || null } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );
    await this.load();
    return { previous, current: this.current() };
  }
}

module.exports = new BigEventDeliverySettingsService();
module.exports.FIELDS = FIELDS;

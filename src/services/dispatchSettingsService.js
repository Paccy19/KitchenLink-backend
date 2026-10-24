const config = require('../config');
const ApiError = require('../utils/ApiError');
const { DispatchSettings } = require('../models');

// Allowed range for each rule: [min, max, decimals allowed].
const LIMITS = {
  radius_km: [0.5, 100, true],
  max_offer_recipients: [1, 500, false],
  location_max_age_minutes: [1, 1440, false],
  rebroadcast_every_seconds: [15, 3600, false],
  max_active_deliveries: [1, 20, false],
  pickup_code_max_attempts: [1, 20, false],
};
const FIELDS = Object.keys(LIMITS);

const defaults = () => ({
  radius_km: config.delivery.defaultRadiusKm,
  max_offer_recipients: config.delivery.maxOfferRecipients,
  location_max_age_minutes: config.delivery.locationMaxAgeMinutes,
  rebroadcast_every_seconds: config.delivery.dispatchTickSeconds,
  max_active_deliveries: config.delivery.maxActiveDeliveries,
  pickup_code_max_attempts: config.orders.pickupCodeMaxAttempts,
  updated_at: null,
  updated_by: null,
});

/**
 * Dispatch and customer-pickup rules an admin can change: who gets notified
 * of a new order (distance, how many, how fresh their position is), how often
 * open orders are re-offered, how many deliveries a worker carries at once and
 * how many wrong pickup codes lock an order. Kept in memory (one server) and
 * refreshed on change; the server config only provides the starting values.
 */
class DispatchSettingsService {
  #current = defaults();

  /** The rules in force right now (synchronous: used while serializing). */
  current() {
    return this.#current;
  }

  async load() {
    const row = await DispatchSettings.findOne({ key: 'primary' }).lean();
    const base = defaults();
    this.#current = row
      ? {
          ...Object.fromEntries(FIELDS.map((field) => [field, row[field] ?? base[field]])),
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        }
      : base;
    return this.#current;
  }

  async update(admin, body = {}) {
    const values = {};
    FIELDS.forEach((field) => {
      const [min, max, decimals] = LIMITS[field];
      const raw = body[field] === undefined || body[field] === '' ? this.#current[field] : body[field];
      const n = decimals ? Math.round(Number(raw) * 10) / 10 : Number(raw);
      if (!Number.isFinite(n) || (!decimals && !Number.isInteger(n)) || n < min || n > max) {
        throw ApiError.badRequest(`${field} must be ${decimals ? 'a number' : 'a whole number'} between ${min} and ${max}.`, {
          [field]: `expected ${min}–${max}`,
        });
      }
      values[field] = n;
    });

    const previous = { ...this.#current };
    await DispatchSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { ...values, updated_by: admin?._id || null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await this.load();
    return { previous, current: this.#current };
  }
}

const service = new DispatchSettingsService();
service.FIELDS = FIELDS;
service.LIMITS = LIMITS;
module.exports = service;

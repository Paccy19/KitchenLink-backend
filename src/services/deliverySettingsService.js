const config = require('../config');
const ApiError = require('../utils/ApiError');
const { DeliverySettings } = require('../models');

const LIMITS = { min: 1, max: 480 };

const defaults = () => ({
  warning_minutes: config.delivery.pickupWarningMinutes,
  charge_after_minutes: config.delivery.pickupGraceMinutes,
  reassign_after_minutes: config.delivery.pickupReassignMinutes || null,
  updated_at: null,
  updated_by: null,
});

/**
 * Delivery timing rules an admin can change: when a delivery worker is
 * warned, when a late pickup is charged, and when the order is taken away and
 * offered to someone else. Kept in memory (one server) and refreshed on
 * change; the server config only provides the starting values.
 */
class DeliverySettingsService {
  #current = defaults();

  /** The rules in force right now (synchronous: used while serializing). */
  current() {
    return this.#current;
  }

  async load() {
    const row = await DeliverySettings.findOne({ key: 'primary' }).lean();
    this.#current = row
      ? {
          warning_minutes: row.warning_minutes,
          charge_after_minutes: row.charge_after_minutes,
          reassign_after_minutes: row.reassign_after_minutes ?? null,
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        }
      : defaults();
    return this.#current;
  }

  /** The clock for a pickup that starts at `start`: when to warn, charge and reassign. */
  pickupClock(start) {
    const rules = this.#current;
    const at = (minutes) => (minutes ? new Date(start.getTime() + minutes * 60000) : null);
    return {
      pickup_started_at: start,
      pickup_warn_at: at(rules.warning_minutes),
      pickup_due_at: at(rules.charge_after_minutes),
      pickup_reassign_at: at(rules.reassign_after_minutes),
    };
  }

  async update(admin, body = {}) {
    const whole = (value, field, { optional = false } = {}) => {
      if (optional && (value === null || value === '' || value === undefined || value === false)) return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < LIMITS.min || n > LIMITS.max) {
        throw ApiError.badRequest(`${field} must be a whole number of minutes between ${LIMITS.min} and ${LIMITS.max}.`, {
          [field]: `expected ${LIMITS.min}–${LIMITS.max}`,
        });
      }
      return n;
    };
    const warning = whole(body.warning_minutes, 'warning_minutes');
    const charge = whole(body.charge_after_minutes, 'charge_after_minutes');
    const reassign = whole(body.reassign_after_minutes, 'reassign_after_minutes', { optional: true });

    if (warning >= charge) {
      throw ApiError.badRequest('The warning has to come before the late charge.', {
        warning_minutes: 'must be less than charge_after_minutes',
      });
    }
    if (reassign !== null && reassign <= charge) {
      throw ApiError.badRequest('Reassigning has to come after the late charge.', {
        reassign_after_minutes: 'must be more than charge_after_minutes',
      });
    }

    const previous = { ...this.#current };
    await DeliverySettings.findOneAndUpdate(
      { key: 'primary' },
      {
        $set: {
          warning_minutes: warning,
          charge_after_minutes: charge,
          reassign_after_minutes: reassign,
          updated_by: admin?._id || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await this.load();
    return { previous, current: this.#current };
  }
}

module.exports = new DeliverySettingsService();

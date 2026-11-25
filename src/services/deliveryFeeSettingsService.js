const config = require('../config');
const { DeliveryFeeSettings } = require('../models');
const { parseDistanceFeeRanges } = require('../utils/distanceFeeRanges');
const { parsePerMeterSettings, perMeterFee } = require('../utils/perMeterPricing');

// No delivery fee may ever be below this.
const MIN_FEE_RWF = 500;
const MAX_FEE_RWF = 100000;
const MAX_KM = 500;

/**
 * Per-meter values before an admin saves any: the starting price of 500 RWF
 * plus 0.3 RWF per meter of road (DELIVERY_PER_METER_* in .env). In use for
 * new orders only when DELIVERY_PER_METER_ENABLED=true; an admin's saved
 * settings always win.
 */
const perMeterDefaults = () => {
  const pm = config.delivery.perMeter;
  const minFee = Math.max(MIN_FEE_RWF, Math.round(pm.minFeeRwf));
  return {
    enabled: pm.enabled,
    base_fee_rwf: Math.round(pm.baseFeeRwf),
    per_meter_rwf: Math.round(pm.rateRwf * 1000) / 1000,
    min_fee_rwf: minFee,
    max_fee_rwf: pm.maxFeeRwf == null ? null : Math.max(minFee, Math.round(pm.maxFeeRwf)),
    route_deviation_alert_percent: 50,
  };
};

/**
 * The admin's standard delivery fee settings:
 *  - per-meter pricing (base fee + road meters x price per meter, between a
 *    minimum and an optional maximum) when enabled;
 *  - otherwise distance ranges, kept sorted, starting at 0 km with no gaps or
 *    overlaps and an open last range ("6 km and more");
 *  - neither set: the formula in config (see deliveryPricingService).
 */
class DeliveryFeeSettingsService {
  #ranges = [];
  #perMeter = null;
  #updatedAt = null;

  async load() {
    const row = await DeliveryFeeSettings.findOne({ key: 'primary' }).lean();
    this.#ranges = (row?.ranges || []).map((range) => ({
      from_km: range.from_km,
      to_km: range.to_km ?? null,
      fee_rwf: range.fee_rwf,
    }));
    this.#perMeter = row?.per_meter
      ? {
          enabled: Boolean(row.per_meter.enabled),
          base_fee_rwf: row.per_meter.base_fee_rwf,
          per_meter_rwf: row.per_meter.per_meter_rwf,
          min_fee_rwf: Math.max(MIN_FEE_RWF, row.per_meter.min_fee_rwf),
          max_fee_rwf: row.per_meter.max_fee_rwf ?? null,
          route_deviation_alert_percent: row.per_meter.route_deviation_alert_percent ?? 50,
        }
      : null;
    this.#updatedAt = row?.updated_at ?? null;
    return this.current();
  }

  current() {
    return {
      // 'per_meter' | 'ranges' | 'formula': what new orders are priced with.
      // (Saved distance ranges are kept but no longer price anything.)
      mode: this.perMeter().enabled ? 'per_meter' : 'formula',
      ranges: this.#ranges,
      per_meter: this.perMeter(),
      per_meter_saved: Boolean(this.#perMeter),
      min_fee_rwf: MIN_FEE_RWF,
      updated_at: this.#updatedAt,
    };
  }

  /** Per-meter settings (saved ones, or the switched-off suggestion). */
  perMeter() {
    return this.#perMeter ? { ...this.#perMeter } : perMeterDefaults();
  }

  /** The per-meter price for these road meters, or null when per-meter pricing is off. */
  perMeterFeeFor(distanceM) {
    const settings = this.perMeter();
    return settings.enabled ? { ...perMeterFee(distanceM, settings), settings } : null;
  }

  /**
   * Body: { ranges?, per_meter? }. Each part is optional, so the ranges and
   * the per-meter settings can be saved separately; what's left out stays.
   */
  async update(admin, body = {}) {
    const set = { updated_by: admin?._id || null };
    if (body.ranges !== undefined) {
      // An empty list goes back to the standard formula.
      set.ranges = parseDistanceFeeRanges(body.ranges, { minFee: MIN_FEE_RWF, maxFee: MAX_FEE_RWF, maxKm: MAX_KM });
    }
    if (body.per_meter !== undefined) {
      set.per_meter = parsePerMeterSettings(body.per_meter, { platformMinFee: MIN_FEE_RWF });
    }
    if (set.ranges === undefined && set.per_meter === undefined) {
      // Older admin screens always sent { ranges }: keep requiring one part.
      parseDistanceFeeRanges(body.ranges, { minFee: MIN_FEE_RWF, maxFee: MAX_FEE_RWF, maxKm: MAX_KM });
    }

    const previous = this.current();
    await DeliveryFeeSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: set },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );
    await this.load();
    return { previous, current: this.current() };
  }
}

module.exports = new DeliveryFeeSettingsService();
module.exports.MIN_FEE_RWF = MIN_FEE_RWF;

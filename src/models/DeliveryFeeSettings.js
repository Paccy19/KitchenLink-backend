const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Standard platform delivery fee settings, set by an admin (single row keyed
 * "primary"). Two ways to price a delivery by distance:
 *
 *  - per_meter (when enabled): fee = base_fee_rwf + road meters x per_meter_rwf,
 *    kept between min_fee_rwf and max_fee_rwf (null = no maximum).
 *  - ranges: each range covers [from_km, to_km); the last range has
 *    to_km = null and covers everything farther.
 *
 * Neither set: the config formula (DELIVERY_*_FEE_RWF). No fee may be below
 * the platform minimum (500 RWF). Orders keep the price they were charged
 * (Order.delivery_pricing), so changing these only affects new orders.
 */
const deliveryFeeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    ranges: [
      {
        _id: false,
        from_km: { type: Number, min: 0, required: true },
        to_km: { type: Number, min: 0, default: null },
        fee_rwf: { type: Number, min: 0, required: true },
      },
    ],
    // Null until an admin saves per-meter pricing for the first time.
    per_meter: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, default: false },
          base_fee_rwf: { type: Number, min: 0, required: true },
          per_meter_rwf: { type: Number, min: 0, required: true },
          min_fee_rwf: { type: Number, min: 0, required: true },
          max_fee_rwf: { type: Number, min: 0, default: null },
          // A delivery whose tracked trip is this much longer than the approved
          // route is flagged for review (the fee never changes).
          route_deviation_alert_percent: { type: Number, min: 0, default: 50 },
        },
        { _id: false }
      ),
      default: null,
    },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('DeliveryFeeSettings', deliveryFeeSettingsSchema);

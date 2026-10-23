const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Delivery fee by distance, set by an admin (single row keyed "primary").
 * Each range covers [from_km, to_km); the last range has to_km = null and
 * covers everything farther. No fee may be below the platform minimum (500 RWF).
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
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('DeliveryFeeSettings', deliveryFeeSettingsSchema);

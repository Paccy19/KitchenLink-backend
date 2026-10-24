const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Dispatch and customer-pickup rules set by an admin (single row keyed
 * "primary"). Until one is saved, the server config provides the values.
 * - radius_km: delivery workers within this distance of the kitchen are
 *   notified of a new order and can take it,
 * - max_offer_recipients: most workers notified per broadcast,
 * - location_max_age_minutes: only positions newer than this count,
 * - rebroadcast_every_seconds: how often open orders are offered again,
 * - max_active_deliveries: deliveries one worker can carry at once,
 * - pickup_code_max_attempts: wrong customer pickup codes before the order locks,
 * - platform_delivery_max_km: farthest drop-off platform workers deliver to;
 *   beyond it only nationwide kitchens deliver (bringing the food themselves).
 */
const dispatchSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    radius_km: { type: Number, min: 0.5, required: true },
    max_offer_recipients: { type: Number, min: 1, required: true },
    location_max_age_minutes: { type: Number, min: 1, required: true },
    rebroadcast_every_seconds: { type: Number, min: 15, required: true },
    max_active_deliveries: { type: Number, min: 1, required: true },
    pickup_code_max_attempts: { type: Number, min: 1, required: true },
    platform_delivery_max_km: { type: Number, min: 1, default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('DispatchSettings', dispatchSettingsSchema);

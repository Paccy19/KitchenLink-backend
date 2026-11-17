const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Big-event delivery pricing, set by an admin (single row keyed "primary").
 * Kept apart from DeliveryFeeSettings (the standard delivery fee) so the two
 * pricing models can never be mixed up. See utils/bigEventDeliveryPricing.js.
 * Orders keep the prices they were charged (Order.big_event_delivery).
 */
const bigEventDeliverySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    enabled: { type: Boolean, default: true },
    starting_fee_rwf: { type: Number, min: 0, required: true },
    per_meter_rwf: { type: Number, min: 0, required: true },
    min_fee_rwf: { type: Number, min: 0, required: true },
    // Highest fee charged automatically; above it the price is negotiated.
    auto_ceiling_rwf: { type: Number, min: 1, required: true },
    // How long a kitchen's quotation stays open for the customer.
    quotation_validity_hours: { type: Number, min: 1, default: 48 },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('BigEventDeliverySettings', bigEventDeliverySettingsSchema);

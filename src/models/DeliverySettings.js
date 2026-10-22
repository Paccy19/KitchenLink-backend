const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

/**
 * Delivery timing rules set by an admin (single row keyed "primary") for
 * workers who delay collecting a ready order. Times count from when the food
 * was marked ready (a worker taking over a late order starts fresh):
 * - warning_minutes: the worker is reminded to collect it,
 * - charge_after_minutes: not collected yet → late pickup with a pending charge,
 * - reassign_after_minutes: still not collected → taken away and offered to
 *   other nearby workers (null = never automatically).
 * - late_penalty_percent: how much of the delivery fee of the late order is
 *   kept by the platform as the penalty (0 = no penalty).
 */
const deliverySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    warning_minutes: { type: Number, min: 1, required: true },
    charge_after_minutes: { type: Number, min: 1, required: true },
    reassign_after_minutes: { type: Number, min: 1, default: null },
    late_penalty_percent: {
      type: Number,
      min: 0,
      max: 100,
      default: config.delivery.latePenaltyPercent,
    },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('DeliverySettings', deliverySettingsSchema);

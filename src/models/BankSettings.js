const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * The banks people can withdraw to and how long each bank's account numbers
 * are (single row keyed "primary", edited by admins). `digits_min` /
 * `digits_max` equal means an exact length; null means "not known yet" and
 * the general 6–30 digit rule applies.
 */
const bankSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    banks: [
      {
        _id: false,
        name: { type: String, required: true, trim: true },
        digits_min: { type: Number, min: 4, max: 34, default: null },
        digits_max: { type: Number, min: 4, max: 34, default: null },
      },
    ],
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('BankSettings', bankSettingsSchema);

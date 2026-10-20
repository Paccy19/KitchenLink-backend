const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone_number: { type: String, required: true },
    profile_image_url: { type: String, default: '' },
    is_verified: { type: Boolean, default: true },
    is_active: { type: Boolean, default: true },
    last_login_at: { type: Date },
    // Last GPS position reported by the customer's browser while using
    // "Use my location" (updated as they move). Absent until first shared.
    last_location: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },
    last_location_accuracy_m: { type: Number, min: 0, default: null },
    last_location_at: { type: Date, default: null },
  },
  { timestamps }
);

customerSchema.index({ phone_number: 1 }, { unique: true });
customerSchema.index({ last_location: '2dsphere' }, { sparse: true });

module.exports = mongoose.model('Customer', customerSchema);

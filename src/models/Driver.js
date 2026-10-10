const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Vehicle categories a driver can register with. Mirrors the vendor model's
 * enum + legacy pattern so older records keep validating.
 */
const VEHICLE_TYPES = ['motorcycle', 'scooter', 'bicycle', 'car', 'foot'];
const LEGACY_VEHICLE_TYPES = ['bike', 'truck'];

const DRIVER_STATUSES = ['online', 'offline', 'busy'];

const driverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    // Credentials (Driver Web App login).
    password_hash: { type: String, select: false },
    last_login_at: { type: Date },
    vehicle_type: {
      type: String,
      enum: [...VEHICLE_TYPES, ...LEGACY_VEHICLE_TYPES],
      default: 'motorcycle',
    },
    plate_number: { type: String, trim: true, default: '' },
    license_number: { type: String, trim: true, default: '' },
    // Last known position on a GeoJSON Point (used for dispatch matching).
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [30.0619, -1.9441], // Kigali city centre [lng, lat]
      },
    },
    location_updated_at: { type: Date },
    is_online: { type: Boolean, default: false },
    is_available: { type: Boolean, default: true },
    status: { type: String, enum: DRIVER_STATUSES, default: 'offline' },
    active_deliveries_count: { type: Number, min: 0, default: 0 },
    max_active_deliveries: { type: Number, min: 1, default: 3 },
    rating: { type: Number, min: 0, max: 5, default: 5 },
    rating_count: { type: Number, min: 0, default: 0 },
    completed_deliveries: { type: Number, min: 0, default: 0 },
    total_earnings_rwf: { type: Number, min: 0, default: 0 },
    profile_image_url: { type: String, default: '' },
    verification_status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
    },
    is_active: { type: Boolean, default: true },
    // Soft delete.
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

driverSchema.index({ location: '2dsphere' });
driverSchema.index({ is_online: 1, is_available: 1, status: 1 });
driverSchema.index({ is_active: 1, rating: -1 });

driverSchema.virtual('latitude').get(function () {
  return this.location?.coordinates?.[1];
});

driverSchema.virtual('longitude').get(function () {
  return this.location?.coordinates?.[0];
});

module.exports = mongoose.model('Driver', driverSchema);
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
module.exports.LEGACY_VEHICLE_TYPES = LEGACY_VEHICLE_TYPES;
module.exports.DRIVER_STATUSES = DRIVER_STATUSES;

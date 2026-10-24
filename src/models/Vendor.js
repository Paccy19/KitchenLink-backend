const mongoose = require('mongoose');
const timestamps = require('./timestamps');

// Vendor type codes (home_cook, restaurant, …) — see config/vendorTypes.js.
const { VENDOR_TYPE_CODES } = require('../config/vendorTypes');

const VENDOR_TYPES = VENDOR_TYPE_CODES;
// Old labels were converted to codes (scripts/migrateVendorTypes.js).
const LEGACY_VENDOR_TYPES = [];

const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    vendor_type: {
      type: String,
      required: true,
      enum: VENDOR_TYPES,
      default: 'restaurant',
    },
    // A type change the vendor asked for, waiting for an admin.
    vendor_type_request: {
      vendor_type: { type: String, enum: [...VENDOR_TYPES, null], default: null },
      reason: { type: String, default: '', trim: true },
      requested_at: { type: Date, default: null },
    },
    // The kitchen's own daily order limit / minimum order (null = its type's
    // default; see config/vendorTypes.js RULES).
    ordering_settings: {
      daily_order_limit: { type: Number, min: 1, default: null },
      min_order_rwf: { type: Number, min: 0, default: null },
    },
    // Taking orders anywhere in Rwanda (see nationwideFor in
    // config/vendorTypes.js). admin_setting: null = the type's default
    // (Caterers on), true/false = set by an admin. Beyond the platform delivery
    // range the kitchen brings the food and charges this travel fee.
    nationwide: {
      admin_setting: { type: Boolean, default: null },
      travel_base_fee_rwf: { type: Number, min: 0, default: null },
      travel_per_km_rwf: { type: Number, min: 0, default: null },
    },
    owner_name: { type: String, trim: true },
    description: { type: String, default: '', trim: true },
    // Credentials (Vendor Dashboard login).
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      index: true,
    },
    phone: { type: String, trim: true, unique: true, sparse: true },
    password_hash: { type: String, select: false },
    last_login_at: { type: Date },
    // Storefront details.
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    neighborhood: { type: String, trim: true },
    address: { type: String, trim: true },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    estimated_prep_time: { type: Number, min: 0, default: 30 },
    is_active: { type: Boolean, default: true },
    // Store open/closed toggle shown in the Vendor Dashboard. Only open stores
    // show on the map, at the registered `location` (entered by the vendor and
    // editable in profile settings; `location_updated_at` = last edit).
    is_open: { type: Boolean, default: true },
    location_updated_at: { type: Date, default: null },
    location_accuracy_m: { type: Number, min: 0, default: null },
    is_featured: { type: Boolean, default: false },
    banner_image_url: { type: String, default: '' },
    profile_image_url: { type: String, default: '' },
    delivery_available: { type: Boolean, default: false },
    // Foods this vendor serves (references discovery categories).
    food_category_ids: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    ],
    food_categories: [{ type: String, trim: true }],
    operating_hours: [
      {
        day: { type: String },
        open_time: { type: String, default: '' },
        close_time: { type: String, default: '' },
        is_closed: { type: Boolean, default: false },
      },
    ],
    // "Tomorrow's Special" announcement. A vendor announces a dish/meal with an
    // order-before cutoff and an intended serving/delivery time; customers can
    // pre-order it until the cutoff.
    special: {
      text: { type: String, default: '', trim: true },
      cutoff_at: { type: Date, default: null },
      delivery_at: { type: Date, default: null },
      is_active: { type: Boolean, default: false },
      updated_at: { type: Date, default: null },
    },
    // Payout details (mobile money or bank transfer).
    payment_information: {
      payout_method: { type: String, default: '' },
      account_name: { type: String, default: '' },
      account_number: { type: String, default: '' },
      bank_name: { type: String, default: '' },
      mobile_money_number: { type: String, default: '' },
    },
    // Uploaded verification documents (ID, licenses, permits).
    verification_documents: [
      {
        label: { type: String, default: '' },
        url: { type: String, required: true },
        uploaded_at: { type: Date, default: Date.now },
      },
    ],
    verification_status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      default: 'approved',
    },
    // Admin verification review. A vendor may only be approved after an admin
    // has opened and acknowledged the uploaded verification documents.
    documents_reviewed_at: { type: Date, default: null },
    documents_reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    // Admin moderation notes.
    rejection_reason: { type: String, default: '' },
    suspension_reason: { type: String, default: '' },
    suspended_at: { type: Date, default: null },
    // Wallet (RWF).
    available_balance: { type: Number, min: 0, default: 0 },
    total_sales: { type: Number, min: 0, default: 0 },
    // Soft delete.
    deleted_at: { type: Date, default: null },
    // Sessions (see utils/sessions.js): tokens issued before this are refused,
    // except the one kept for the device that signed the others out.
    sessions_valid_after: { type: Date, default: null },
    sessions_kept_jti: { type: String, default: null },
  },
  { timestamps }
);

vendorSchema.index({ location: '2dsphere' });
vendorSchema.index({ is_active: 1, rating: -1 });
vendorSchema.index({ is_active: 1, is_featured: -1, rating: -1 });
vendorSchema.index({ name: 'text', neighborhood: 'text' });
vendorSchema.index({ 'special.is_active': 1, 'special.delivery_at': 1 });
vendorSchema.index({ vendor_type: 1, is_active: 1 });

vendorSchema.virtual('latitude').get(function () {
  return this.location?.coordinates?.[1];
});

vendorSchema.virtual('longitude').get(function () {
  return this.location?.coordinates?.[0];
});

module.exports = mongoose.model('Vendor', vendorSchema);
module.exports.VENDOR_TYPES = VENDOR_TYPES;
module.exports.LEGACY_VENDOR_TYPES = LEGACY_VENDOR_TYPES;

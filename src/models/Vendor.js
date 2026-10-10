const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Canonical vendor types available to the Vendor Dashboard.
 * Legacy values kept so existing records continue to validate.
 */
const VENDOR_TYPES = [
  'Home Cook',
  'Restaurant',
  'Café',
  'Bakery',
  'Caterer',
  'Food Truck',
  'Chef',
  'Meal-prep business',
  'Juice/Drinks vendor',
  'Other food business',
];

const LEGACY_VENDOR_TYPES = ['Cafe', 'Bar & Grill'];

const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    vendor_type: {
      type: String,
      required: true,
      enum: [...VENDOR_TYPES, ...LEGACY_VENDOR_TYPES],
      default: 'Restaurant',
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
    // Store open/closed toggle shown in the Vendor Dashboard.
    is_open: { type: Boolean, default: true },
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
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
    },
    // Wallet (RWF).
    available_balance: { type: Number, min: 0, default: 0 },
    total_sales: { type: Number, min: 0, default: 0 },
    // Soft delete.
    deleted_at: { type: Date, default: null },
  },
  { timestamps }
);

vendorSchema.index({ location: '2dsphere' });
vendorSchema.index({ is_active: 1, rating: -1 });
vendorSchema.index({ is_active: 1, is_featured: -1, rating: -1 });
vendorSchema.index({ name: 'text', neighborhood: 'text' });

vendorSchema.virtual('latitude').get(function () {
  return this.location?.coordinates?.[1];
});

vendorSchema.virtual('longitude').get(function () {
  return this.location?.coordinates?.[0];
});

module.exports = mongoose.model('Vendor', vendorSchema);
module.exports.VENDOR_TYPES = VENDOR_TYPES;
module.exports.LEGACY_VENDOR_TYPES = LEGACY_VENDOR_TYPES;

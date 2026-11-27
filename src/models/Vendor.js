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
    // Big events, set by the kitchen (see config/eventPackages.js): guest
    // ranges with a price per plate, the plate, the service and the delivery
    // (fee by distance range).
    event_package: {
      enabled: { type: Boolean, default: false },
      // The kitchen's ways of hosting events ("Wedding buffet", "Corporate
      // lunch" …), each with its own guest ranges, plate and service.
      // Kitchens saved before packages existed keep their single offer in the
      // old top-level fields (read as one package, see eventPackageFor).
      packages: [
        {
          _id: false,
          id: { type: String, required: true },
          name: { type: String, required: true, trim: true },
          description: { type: String, default: '', trim: true },
          enabled: { type: Boolean, default: true },
          tiers: [
            {
              _id: false,
              min_guests: { type: Number, min: 1, required: true },
              max_guests: { type: Number, min: 1, required: true },
              price_per_plate_rwf: { type: Number, min: 0, required: true },
            },
          ],
          menu: [{ type: String, trim: true }],
          portion: { type: String, default: '', trim: true },
          service_style: { type: String, enum: ['buffet', 'served', 'drop_off'], default: 'buffet' },
          service_details: { type: String, default: '', trim: true },
        },
      ],
      // One delivery fee by distance for all packages, like the admin's ranges.
      delivery_fee_ranges: [
        {
          _id: false,
          from_km: { type: Number, min: 0, required: true },
          to_km: { type: Number, min: 0, default: null },
          fee_rwf: { type: Number, min: 0, required: true },
        },
      ],
      delivery_details: { type: String, default: '', trim: true },
      updated_at: { type: Date, default: null },
    },
    // Big-event delivery coverage, set by the kitchen (config/deliveryCoverage.js):
    // where it is able to deliver big events. It never sets the price —
    // big-event delivery is priced by the platform.
    delivery_coverage: {
      big_event_enabled: { type: Boolean, default: false },
      areas: [
        {
          _id: false,
          id: { type: String, required: true },
          kind: { type: String, enum: ['district', 'radius'], required: true },
          district: { type: String, default: null },
          label: { type: String, default: '', trim: true },
          // A radius without a centre is measured from the kitchen.
          latitude: { type: Number, default: null },
          longitude: { type: Number, default: null },
          radius_km: { type: Number, min: 0, default: null },
        },
      ],
      updated_at: { type: Date, default: null },
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
    // Photos of the kitchen's own printed menu, shown to customers next to the
    // dishes it lists one by one (they can't be ordered from: dishes can).
    menu_photos: [
      {
        url: { type: String, required: true },
        caption: { type: String, default: '', trim: true },
        sort_order: { type: Number, default: 0 },
        uploaded_at: { type: Date, default: Date.now },
      },
    ],
    // In-house operations (departments, tables, cashier). See kitchenAccess.js.
    operations: {
      // When dine-in customers pay (kitchenAccess.PAYMENT_TIMINGS).
      payment_timing: { type: String, default: 'after_service' },
      // Table QR ordering on/off.
      table_ordering_enabled: { type: Boolean, default: true },
      // Servers may take ready items before every department is done.
      allow_partial_service: { type: Boolean, default: true },
      // Deduct stock from recipes when a ticket is marked ready.
      inventory_auto_deduct: { type: Boolean, default: false },
      // Automatic team alerts on/off (kitchenAccess.ALERT_TYPES); missing = on.
      alerts: { type: mongoose.Schema.Types.Mixed, default: {} },
      // Loyalty points: earned on paid bills, spent as a discount.
      loyalty: {
        enabled: { type: Boolean, default: false },
        // 1 point for every this many RWF spent.
        earn_per_rwf: { type: Number, min: 100, default: 1000 },
        // What one point is worth when spent.
        point_value_rwf: { type: Number, min: 1, default: 10 },
      },
      // Delivery and pickup orders are packed and checked before they leave.
      require_packing: { type: Boolean, default: false },
      // Minutes an order may wait with nobody accepting it before the managers
      // get an urgent alert and an SMS (newOrderWatchService). 0 = off.
      escalate_after_minutes: { type: Number, min: 0, max: 60, default: 5 },
      // Several departments' delivery items may leave separately.
      allow_partial_dispatch: { type: Boolean, default: false },
      // What must be true before a table session closes (a manager may override).
      session_close: {
        orders_complete: { type: Boolean, default: true },
        paid: { type: Boolean, default: true },
        packing_resolved: { type: Boolean, default: true },
        requests_resolved: { type: Boolean, default: false },
      },
      reservations: {
        enabled_online: { type: Boolean, default: true },
        duration_minutes: { type: Number, min: 15, max: 720, default: 90 },
        buffer_minutes: { type: Number, min: 0, max: 240, default: 15 },
        max_party: { type: Number, min: 1, max: 200, default: 12 },
        // Online bookings wait for the host to confirm them.
        require_confirmation: { type: Boolean, default: true },
        deposit_per_guest_rwf: { type: Number, min: 0, default: 0 },
        // A cancellation this many hours before (or more) gets the deposit back.
        refund_deposit_hours: { type: Number, min: 0, default: 24 },
        // No-show: the deposit is kept.
        keep_deposit_on_no_show: { type: Boolean, default: true },
        preorders: { type: Boolean, default: true },
        // Pre-orders start this many minutes before the booking (0 = when the guests arrive).
        preorder_lead_minutes: { type: Number, min: 0, max: 240, default: 0 },
        reminder_minutes: { type: Number, min: 0, max: 1440, default: 120 },
      },
      // The starting roles were created (once).
      default_roles_created: { type: Boolean, default: false },
      updated_at: { type: Date, default: null },
    },
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
vendorSchema.index({ 'event_package.enabled': 1, is_active: 1 });

vendorSchema.virtual('latitude').get(function () {
  return this.location?.coordinates?.[1];
});

vendorSchema.virtual('longitude').get(function () {
  return this.location?.coordinates?.[0];
});

module.exports = mongoose.model('Vendor', vendorSchema);
module.exports.VENDOR_TYPES = VENDOR_TYPES;
module.exports.LEGACY_VENDOR_TYPES = LEGACY_VENDOR_TYPES;

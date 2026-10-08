const mongoose = require('mongoose');

const VENDOR_TYPES = [
  'Home Cook',
  'Restaurant',
  'Bakery',
  'Cafe',
  'Food Truck',
  'Bar & Grill',
];

const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    vendor_type: {
      type: String,
      required: true,
      enum: VENDOR_TYPES,
      default: 'Restaurant',
    },
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
    is_featured: { type: Boolean, default: false },
    banner_image_url: { type: String, default: '' },
    delivery_available: { type: Boolean, default: false },
  },
  { timestamps: true }
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

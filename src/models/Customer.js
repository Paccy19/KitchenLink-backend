const mongoose = require('mongoose');
const timestamps = require('./timestamps');

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // A verified phone only (+2507…, proven with an SMS code): the sign-in
    // phone. Unique among customers. Absent for customers who signed up with
    // an email and have not verified a phone yet.
    phone_number: { type: String },
    // A phone given but not proven yet (email sign-up, or a change waiting for
    // its code). Never proof of ownership, never used to sign in, not unique.
    pending_phone_number: { type: String, default: undefined },
    // Optional; unique among customers when set. Only an email proven with a
    // code (email_verified_at) is used to sign in or receives delivery codes.
    email: { type: String, trim: true, lowercase: true },
    email_verified_at: { type: Date, default: null },
    // A new email waiting for its code (the current one stays until then).
    pending_email: { type: String, trim: true, lowercase: true, default: undefined },
    profile_image_url: { type: String, default: '' },
    is_verified: { type: Boolean, default: true },
    is_active: { type: Boolean, default: true },
    last_login_at: { type: Date },
    // Personal data erased on request (customerErasureService): kept only as
    // an anonymous record so orders and payments still add up.
    erased_at: { type: Date, default: null },
    erased_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    // Sessions (see utils/sessions.js): tokens issued before this are refused,
    // except the one kept for the device that signed the others out.
    sessions_valid_after: { type: Date, default: null },
    sessions_kept_jti: { type: String, default: null },
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

// One customer per phone (scripts/migrateCustomerIdentity.js replaced the
// older index that also required every customer to have one).
customerSchema.index(
  { phone_number: 1 },
  { name: 'phone_number_unique_when_set', unique: true, partialFilterExpression: { phone_number: { $type: 'string' } } }
);
customerSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
customerSchema.index({ last_location: '2dsphere' }, { sparse: true });

module.exports = mongoose.model('Customer', customerSchema);

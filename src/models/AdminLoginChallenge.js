const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Stage 1 → stage 2 of the admin sign-in through the customer phone login:
 * created when a customer sign-in code was verified for a phone that belongs
 * to an active admin (services/adminPhoneLoginService.js). It proves only
 * that this phone was verified a moment ago — never admin access by itself.
 *
 * Only the SHA-256 of the random token given to the browser is stored. A
 * challenge is short-lived, used once (to finish the admin sign-in, or to
 * continue as a customer), and dropped after too many wrong passwords.
 */
const adminLoginChallengeSchema = new mongoose.Schema(
  {
    token_hash: { type: String, required: true, unique: true },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    // The phone verified with the code (must still be the admin's phone).
    phone: { type: String, required: true },
    // The name typed at the customer sign-in, kept in case the person
    // continues as a customer and has no customer account yet.
    customer_name: { type: String, default: '' },
    attempts: { type: Number, default: 0, min: 0 },
    expires_at: { type: Date, required: true },
    used_at: { type: Date, default: null },
    used_for: { type: String, enum: ['admin', 'customer', 'too_many_attempts', null], default: null },
  },
  { timestamps }
);

// Mongo removes challenges once they expire.
adminLoginChallengeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AdminLoginChallenge', adminLoginChallengeSchema);

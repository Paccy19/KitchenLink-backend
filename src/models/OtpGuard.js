const mongoose = require('mongoose');
const timestamps = require('./timestamps');

/**
 * Brute-force guard for one phone number and one kind of sign-in code
 * (key "<purpose>:<phone>"). Kept apart from the codes themselves, which are
 * deleted when they expire, so lockouts and daily caps outlive them.
 */
const otpGuardSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    // Wrong codes since `failures_since` (a rolling day).
    failures: { type: Number, default: 0 },
    failures_since: { type: Date, default: null },
    // How many lockouts in a row (longer each time); reset by a correct code.
    lock_level: { type: Number, default: 0 },
    locked_until: { type: Date, default: null },
    // Codes sent since `sends_since` (a rolling day).
    sends: { type: Number, default: 0 },
    sends_since: { type: Date, default: null },
  },
  { timestamps }
);

module.exports = mongoose.model('OtpGuard', otpGuardSchema);

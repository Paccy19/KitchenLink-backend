const crypto = require('crypto');
const config = require('../config');

/**
 * Sign-in codes are stored as an HMAC-SHA256 keyed with the server secret, so
 * someone reading the database can't use (or brute-force offline) the codes
 * waiting there. The secret never leaves the server.
 */
const hashOtp = (code) => crypto.createHmac('sha256', `otp:${config.auth.jwtSecret}`).update(String(code)).digest('hex');

/** Constant-time check of `rawCode` against a stored code (hashed, or plaintext from before hashing). */
function otpMatches(stored, rawCode) {
  if (stored?.code_hash) {
    const expected = Buffer.from(stored.code_hash, 'hex');
    const given = Buffer.from(hashOtp(rawCode), 'hex');
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
  if (typeof stored?.code === 'string' && stored.code.length === String(rawCode).length) {
    return crypto.timingSafeEqual(Buffer.from(stored.code), Buffer.from(String(rawCode)));
  }
  return false;
}

module.exports = { hashOtp, otpMatches };

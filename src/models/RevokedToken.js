const mongoose = require('mongoose');

/**
 * Signed-out sessions: a token whose id (`jti`) is here is refused even though
 * its signature is fine. Each entry is deleted when the token would have
 * expired anyway (TTL index), so the list stays small.
 */
const revokedTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  expires_at: { type: Date, required: true },
});

revokedTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RevokedToken', revokedTokenSchema);

const mongoose = require('mongoose');

/**
 * When an admin session (token id `jti`) was last used, for the idle timeout
 * (see utils/sessions.js assertNotIdle). Deleted automatically when the token
 * would have expired anyway (TTL index).
 */
const sessionActivitySchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  last_seen_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
});

sessionActivitySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SessionActivity', sessionActivitySchema);

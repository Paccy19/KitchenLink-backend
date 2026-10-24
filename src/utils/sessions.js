const ApiError = require('./ApiError');
const { RevokedToken } = require('../models');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Session revocation for every account type (customer, vendor, driver, admin):
 *  - signing out revokes that one token (by its id, `jti`),
 *  - "sign out everywhere" (and a password change) sets the account's
 *    `sessions_valid_after`: tokens issued before it are refused, except the
 *    one kept for the device that asked (`sessions_kept_jti`).
 * Tokens are signed JWTs, so these checks run on every request in the
 * requireXAuth middlewares.
 */
async function assertSessionActive(payload, account) {
  if (payload.jti && (await RevokedToken.exists({ jti: payload.jti }))) {
    throw ApiError.unauthorized('You signed out of this session. Please log in again.', 'SESSION_REVOKED');
  }
  const validAfter = account?.sessions_valid_after ? new Date(account.sessions_valid_after).getTime() : 0;
  const kept = payload.jti && payload.jti === account?.sessions_kept_jti;
  // Older tokens only carry whole seconds (iat).
  const issuedAt = payload.iat_ms || payload.iat * 1000;
  if (validAfter && issuedAt < validAfter && !kept) {
    throw ApiError.unauthorized('This session was signed out. Please log in again.', 'SESSION_REVOKED');
  }
}

/** Signs out one token (until it would have expired anyway). */
async function revokeToken(payload) {
  if (!payload?.jti) return;
  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 30 * DAY_MS);
  await RevokedToken.updateOne({ jti: payload.jti }, { $set: { expires_at: expiresAt } }, { upsert: true });
}

/**
 * Signs out every session of an account issued until now; `keepPayload` (the
 * token of the device asking, e.g. after a password change) keeps working.
 */
async function revokeAllSessions(Model, accountId, { keepPayload = null } = {}) {
  const now = Date.now();
  await Model.updateOne(
    { _id: accountId },
    { $set: { sessions_valid_after: new Date(now), sessions_kept_jti: keepPayload?.jti || null } }
  );
}

/**
 * Route handlers for one account type: `logout` signs out this device,
 * `logoutAll` every device (this one included). `reqKey` is where the auth
 * middleware put the account (req.customer, req.vendor, ...).
 */
const sessionHandlers = (Model, reqKey) => ({
  logout: async (req, res, next) => {
    try {
      await revokeToken(req.tokenPayload);
      res.json({ signed_out: true });
    } catch (error) {
      next(error);
    }
  },
  logoutAll: async (req, res, next) => {
    try {
      await revokeAllSessions(Model, req[reqKey]._id);
      await revokeToken(req.tokenPayload);
      res.json({ signed_out: true, all_devices: true });
    } catch (error) {
      next(error);
    }
  },
});

module.exports = { assertSessionActive, revokeToken, revokeAllSessions, sessionHandlers };

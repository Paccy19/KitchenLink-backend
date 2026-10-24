const ApiError = require('./ApiError');
const { RevokedToken, SessionActivity } = require('../models');

// Activity is written at most this often per session (not on every request).
const ACTIVITY_WRITE_EVERY_MS = 60 * 1000;

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

/**
 * Idle timeout (admin sessions): a session unused for `idleMinutes` is
 * signed out, even though its token hasn't expired: e.g. an admin who walked
 * away from a shared computer, or a tab closed and reopened later.
 */
async function assertNotIdle(payload, idleMinutes) {
  if (!payload?.jti || !idleMinutes) return;
  const now = Date.now();
  const activity = await SessionActivity.findOne({ jti: payload.jti }).lean();
  if (activity && now - new Date(activity.last_seen_at).getTime() > idleMinutes * 60 * 1000) {
    await revokeToken(payload);
    throw ApiError.unauthorized(
      `You were signed out after ${idleMinutes} minutes without activity. Please log in again.`,
      'SESSION_IDLE'
    );
  }
  if (!activity || now - new Date(activity.last_seen_at).getTime() > ACTIVITY_WRITE_EVERY_MS) {
    await SessionActivity.updateOne(
      { jti: payload.jti },
      { $set: { last_seen_at: new Date(now), expires_at: new Date(payload.exp ? payload.exp * 1000 : now + 86400000) } },
      { upsert: true }
    );
  }
}

module.exports = { assertSessionActive, assertNotIdle, revokeToken, revokeAllSessions, sessionHandlers };

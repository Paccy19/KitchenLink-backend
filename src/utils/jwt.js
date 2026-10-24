const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

// Each session token has its own id (jti) so signing out can revoke just it.
const signToken = (payload, { expiresIn = config.auth.jwtExpiresIn } = {}) =>
  // iat_ms: when it was issued, to the millisecond (iat is whole seconds).
  jwt.sign({ ...payload, jti: crypto.randomUUID(), iat_ms: Date.now() }, config.auth.jwtSecret, { expiresIn });

const verifyToken = (token) => jwt.verify(token, config.auth.jwtSecret);

/** Short-lived token for an unfinished step (e.g. the admin SMS sign-in code). */
const signShortToken = (payload, expiresIn = '10m') =>
  jwt.sign(payload, config.auth.jwtSecret, { expiresIn });

module.exports = { signToken, verifyToken, signShortToken };

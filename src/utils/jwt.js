const jwt = require('jsonwebtoken');
const config = require('../config');

const signToken = (payload) =>
  jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
  });

const verifyToken = (token) => jwt.verify(token, config.auth.jwtSecret);

/** Short-lived token for an unfinished step (e.g. the admin SMS sign-in code). */
const signShortToken = (payload, expiresIn = '10m') =>
  jwt.sign(payload, config.auth.jwtSecret, { expiresIn });

module.exports = { signToken, verifyToken, signShortToken };

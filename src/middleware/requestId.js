const crypto = require('crypto');

// An id from a proxy / load balancer is reused only if it looks harmless
// (it's written to the logs).
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Gives every request a short id (req.id), returned as the X-Request-Id
 * header and written in the request log, the error log and the message of
 * server errors ("Reference: 3f9a1c2e"), so a user's report can be matched
 * to the exact failure in the logs.
 */
const requestId = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomBytes(4).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
};

module.exports = requestId;

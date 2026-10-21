const ApiError = require('../utils/ApiError');

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP, for public
 * endpoints that call paid or fair-use third-party services. Suitable for a
 * single instance; swap for a shared store if the API scales out.
 */
function rateLimit({ windowMs, max, code = 'RATE_LIMITED', message = 'Too many requests. Please slow down.' }) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size >= 5000) {
      for (const [key, bucket] of buckets.entries()) {
        if (now - bucket.start >= windowMs) buckets.delete(key);
      }
    }

    const key = req.ip || 'anonymous';
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) return next(ApiError.tooMany(message, code));
    return next();
  };
}

module.exports = rateLimit;

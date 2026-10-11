const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Minimal in-memory fixed-window rate limiter for admin API traffic. Suitable
 * for a single instance; swap for a shared store if the API scales out.
 */
const buckets = new Map();

const prune = (now, windowMs) => {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.start > windowMs) buckets.delete(key);
  }
};

const adminRateLimit = (req, res, next) => {
  const { windowMs, max } = config.admin.rateLimit;
  const now = Date.now();
  prune(now, windowMs);

  const key = req.admin ? String(req.admin._id) : req.ip || 'anonymous';
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const remaining = Math.max(max - bucket.count, 0);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (bucket.count > max) {
    return next(
      ApiError.tooMany('Too many admin requests. Please slow down.', 'ADMIN_RATE_LIMITED')
    );
  }
  return next();
};

module.exports = adminRateLimit;

const config = require('../config');

/**
 * A vendor is "live" (shown to customers as open nearby) when the store is
 * switched open and its location was shared recently. Vendors share their GPS
 * position when they open the store, and the dashboard keeps refreshing it.
 */
const maxAgeMs = () => config.vendor.locationMaxAgeHours * 60 * 60 * 1000;

/**
 * Mongo filter for live vendors. Pass `prefix` when matching a looked-up
 * vendor document (e.g. `'vendor'` -> `vendor.is_open`).
 */
function liveVendorFilter(prefix = '') {
  const key = (field) => (prefix ? `${prefix}.${field}` : field);
  const filter = { [key('is_open')]: { $ne: false } };
  if (maxAgeMs() > 0) {
    filter[key('location_updated_at')] = { $gte: new Date(Date.now() - maxAgeMs()) };
  }
  return filter;
}

/** Aggregation expression equivalent of `liveVendorFilter` (true/false per doc). */
function liveVendorExpr() {
  const conditions = [{ $ne: ['$is_open', false] }];
  if (maxAgeMs() > 0) {
    conditions.push({ $gte: ['$location_updated_at', new Date(Date.now() - maxAgeMs())] });
  }
  return { $and: conditions };
}

function isVendorLive(vendor) {
  if (!vendor || vendor.is_open === false) return false;
  if (maxAgeMs() <= 0) return true;
  const sharedAt = vendor.location_updated_at ? new Date(vendor.location_updated_at).getTime() : 0;
  return Date.now() - sharedAt <= maxAgeMs();
}

module.exports = { liveVendorFilter, liveVendorExpr, isVendorLive };

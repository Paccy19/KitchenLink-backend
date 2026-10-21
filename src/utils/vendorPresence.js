/**
 * A vendor is "live" (shown to customers and on the map) while the store is
 * switched open. The kitchen's position is the coordinates the vendor
 * registered (editable in profile settings), never a live GPS reading, so a
 * vendor managing the business away from the kitchen doesn't move it.
 */

/**
 * Mongo filter for live vendors. Pass `prefix` when matching a looked-up
 * vendor document (e.g. `'vendor'` -> `vendor.is_open`).
 */
function liveVendorFilter(prefix = '') {
  const key = (field) => (prefix ? `${prefix}.${field}` : field);
  return { [key('is_open')]: { $ne: false } };
}

/** Aggregation expression equivalent of `liveVendorFilter` (true/false per doc). */
function liveVendorExpr() {
  return { $ne: ['$is_open', false] };
}

function isVendorLive(vendor) {
  return Boolean(vendor) && vendor.is_open !== false;
}

module.exports = { liveVendorFilter, liveVendorExpr, isVendorLive };

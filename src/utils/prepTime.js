/**
 * How long an order takes to prepare: each dish has its own time
 * (MenuItem.preparation_time_minutes); departments cook in parallel, so the
 * order takes as long as its slowest dish. A dish without a time uses the
 * kitchen's default (Vendor.estimated_prep_time).
 */
const DEFAULT_MINUTES = 30;

function dishMinutes(dish, vendor) {
  const own = Number(dish?.preparation_time_minutes);
  if (Number.isFinite(own) && own > 0) return Math.round(own);
  const fallback = Number(vendor?.estimated_prep_time);
  return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : DEFAULT_MINUTES;
}

function orderPrepMinutes(dishes = [], vendor = null) {
  const list = dishes.filter(Boolean);
  if (!list.length) return dishMinutes(null, vendor);
  return Math.max(...list.map((d) => dishMinutes(d, vendor)));
}

module.exports = { dishMinutes, orderPrepMinutes };

/**
 * GET /vendor/dashboard for kitchen staff: only the figures their role shows
 * (config/kitchenAccess.js, "Kitchen Overview & Dashboard"). Balances and
 * withdrawals are the administrators' (the wallet).
 */
const SECTIONS = [
  { permission: ['overview.sales', 'overview.financial_summary'], keys: /_sales_rwf$|^commission_percent$|^net_earned_rwf$/ },
  { permission: ['overview.orders', 'overview.statistics'], keys: /^(today_orders|completed_orders|completed_orders_total|cancelled_orders)$/ },
  { permission: ['overview.pending_orders', 'overview.statistics'], keys: /^(pending_orders|new_orders|preparing_orders|ready_orders)$/ },
  { permission: ['account.wallet'], keys: /balance_rwf$|^withdrawn_rwf$/ },
];

function strip(value, hidden, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((entry) => strip(entry, hidden, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (hidden.some((rx) => rx.test(key))) continue;
    out[key] = strip(entry, hidden, depth + 1);
  }
  return out;
}

module.exports = function kitchenDashboardFilter(req, res, next) {
  const kitchen = req.kitchenAccess;
  if (!kitchen || kitchen.isAdmin) return next();
  const hidden = SECTIONS.filter((section) => !section.permission.some((p) => kitchen.can(p))).map((section) => section.keys);
  if (!hidden.length) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(strip(body, hidden));
  return next();
};

/**
 * What every kitchen route accepts, read from the routes themselves (the
 * `requireKitchenPermission(...)` middleware on each one), so the website
 * shows a button exactly when the server would allow the request.
 *
 *   { 'POST /vendor/inventory/:item_id/adjust': ['inventory.adjust', ...], ... }
 *
 * A route with no permission middleware is open to any kitchen session
 * (the service then checks); `['admin']` = kitchen administrators only.
 */
const entries = new Map();

function collect(prefix, router, inherited = []) {
  const stack = router?.stack || [];
  // Router-wide middleware (router.use(can(...))) applies to every route below it.
  let wide = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const handlers = route.stack.map((l) => l.handle);
      const lists = handlers.filter((h) => h.kitchenPermissions).map((h) => h.kitchenPermissions);
      const adminOnly = handlers.some((h) => h.kitchenAdminOnly);
      const permissions = adminOnly ? ['admin'] : lists.length ? lists[lists.length - 1] : wide.length ? wide[wide.length - 1] : [];
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const method of Object.keys(route.methods).filter((m) => route.methods[m])) {
        for (const path of paths) {
          const full = `${prefix}${path === '/' ? '' : path}` || prefix;
          entries.set(`${method.toUpperCase()} ${full}`, permissions);
        }
      }
    } else if (layer.handle?.kitchenPermissions) {
      wide = [...wide, layer.handle.kitchenPermissions];
    }
  }
}

const all = () => Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));

module.exports = { collect, all };

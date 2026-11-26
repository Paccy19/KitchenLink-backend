const ApiError = require('../utils/ApiError');

/**
 * Use after `requireVendorAuth`: refuses the request unless the kitchen
 * session holds at least one of the permissions (config/kitchenAccess.js).
 * The kitchen owner and kitchen administrators hold all of them.
 * Department-scoped checks (which department's ticket or dish) are made
 * again in the services, once the record is known.
 */
const requireKitchenPermission = (...permissions) => (req, res, next) => {
  const kitchen = req.kitchenAccess;
  if (!kitchen) return next(ApiError.unauthorized('Sign in to your kitchen to continue.'));
  if (permissions.some((permission) => kitchen.can(permission))) return next();
  try {
    kitchen.assert(permissions[0]);
  } catch (error) {
    return next(error);
  }
  return next();
};

/** Only the kitchen account itself and kitchen administrators. */
requireKitchenPermission.admin = (req, res, next) => {
  if (req.kitchenAccess?.isAdmin) return next();
  return next(
    ApiError.forbidden('Only the kitchen administrator can do this.', 'KITCHEN_ADMIN_ONLY')
  );
};

module.exports = requireKitchenPermission;

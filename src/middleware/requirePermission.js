const ApiError = require('../utils/ApiError');

/**
 * Permission gate for admin routes. Super admins (or admins with an empty
 * permissions list) bypass individual permission checks.
 */
const requirePermission = (permission) => (req, res, next) => {
  const admin = req.admin;
  if (!admin) {
    return next(ApiError.unauthorized('Authentication required.'));
  }
  if (admin.role === 'super_admin') return next();
  const permissions = admin.permissions || [];
  if (permissions.length === 0 || permissions.includes(permission)) return next();
  return next(
    ApiError.forbidden(
      `You do not have permission to perform this action (${permission}).`,
      'PERMISSION_DENIED'
    )
  );
};

module.exports = requirePermission;

const ApiError = require('../utils/ApiError');

/**
 * Only the owner (super admin) may touch the platform's own money. Unlike
 * `requirePermission`, an empty permissions list does not grant access here.
 */
const requireSuperAdmin = (req, res, next) => {
  if (req.admin?.role === 'super_admin') return next();
  return next(ApiError.forbidden('Only the platform owner can do this.', 'OWNER_ONLY'));
};

module.exports = requireSuperAdmin;

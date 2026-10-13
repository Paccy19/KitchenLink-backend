const ApiError = require('../utils/ApiError');
const { can } = require('../config/adminAccess');

/**
 * Permission gate for admin routes. An admin may only do what their role
 * allows (config/adminAccess.js); the owner (super admin) may do everything.
 */
const requirePermission = (permission) => (req, res, next) => {
  const admin = req.admin;
  if (!admin) {
    return next(ApiError.unauthorized('Authentication required.'));
  }
  if (can(admin, permission)) return next();
  return next(
    new ApiError(403, 'PERMISSION_DENIED', 'Your role does not allow this. Ask the owner if you need access.', { permission })
  );
};

module.exports = requirePermission;

const ApiError = require('../utils/ApiError');

/**
 * An admin still on the seeded password (publicly known) may only change it:
 * every other admin action is refused. Changing the password, signing in and
 * /admin/auth/me live under /admin/auth, which this does not guard.
 */
const requirePasswordChanged = (req, res, next) => {
  if (req.admin?.must_change_password) {
    return next(
      ApiError.forbidden(
        'You are still using the default admin password. Change it in Settings → Profile before doing anything else.',
        'PASSWORD_CHANGE_REQUIRED'
      )
    );
  }
  return next();
};

module.exports = requirePasswordChanged;

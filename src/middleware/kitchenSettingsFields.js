const ApiError = require('../utils/ApiError');

/**
 * PATCH /vendor/profile changes several kinds of kitchen settings at once.
 * Each field needs its own permission (config/kitchenAccess.js); payout
 * details (where the money goes) stay with kitchen administrators.
 * Runs after multer, so uploaded images are seen too.
 */
const FIELD_PERMISSIONS = [
  [['banner_image', 'profile_image', 'banner_image_base64', 'banner_image_url', 'profile_image_base64', 'profile_image_url'], 'settings.images'],
  [['phone', 'email'], 'settings.contact'],
  [['operating_hours'], 'settings.hours'],
  [['is_open'], 'settings.availability'],
  [['payment_information'], 'account.wallet'],
];

module.exports = function kitchenSettingsFields(req, res, next) {
  const kitchen = req.kitchenAccess;
  if (!kitchen || kitchen.isAdmin) return next();
  const sent = new Set([...Object.keys(req.body || {}), ...Object.keys(req.files || {})]);
  try {
    const claimed = new Set();
    for (const [fields, permission] of FIELD_PERMISSIONS) {
      if (fields.some((field) => sent.has(field))) {
        kitchen.assert(permission);
        fields.forEach((field) => claimed.add(field));
      }
    }
    // Anything else (name, description, location …) is the kitchen profile.
    if ([...sent].some((field) => !claimed.has(field))) kitchen.assert('settings.edit_profile');
    return next();
  } catch (error) {
    return next(error instanceof ApiError ? error : ApiError.forbidden('Not allowed.'));
  }
};

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { assertSessionActive } = require('../utils/sessions');
const vendorRepository = require('../repositories/vendorRepository');
const { assertVendorNotBlocked } = require('../utils/vendorAccess');
const kitchenAccess = require('../services/kitchen/accessService');

const requireVendorAuth = async (req, res, next) => {
  // Already checked for this request (a permission gate in front of a router).
  if (req.vendor && req.kitchenAccess) return next();
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing bearer token. Log in to continue.');
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw ApiError.unauthorized(
          'Session expired. Please log in again.',
          'TOKEN_EXPIRED'
        );
      }
      throw ApiError.unauthorized('Invalid or malformed token.', 'INVALID_TOKEN');
    }

    if (payload.role !== config.vendor.jwtRole) {
      throw ApiError.forbidden('Vendor credentials are required.', 'VENDOR_ONLY');
    }

    const vendor = await vendorRepository.findById(payload.sub);
    if (!vendor) {
      throw ApiError.unauthorized('Vendor account no longer exists.', 'INVALID_TOKEN');
    }
    // Vendors suspended or rejected while signed in lose access immediately.
    assertVendorNotBlocked(vendor);

    // A kitchen employee's session carries their staff id: their own account
    // decides whether the session still works and what they may do.
    if (payload.staff_id) {
      const staff = await kitchenAccess.loadStaffForSession(vendor, payload.staff_id);
      await assertSessionActive(payload, staff);
      req.staff = staff;
      req.kitchenAccess = await kitchenAccess.forStaff(vendor, staff);
    } else {
      // Signed out (this device, or everywhere) or password changed since.
      await assertSessionActive(payload, vendor);
      req.kitchenAccess = kitchenAccess.forOwner(vendor);
    }
    req.tokenPayload = payload;
    req.vendor = vendor;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireVendorAuth;

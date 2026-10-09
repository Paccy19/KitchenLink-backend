const config = require('../config');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const vendorRepository = require('../repositories/vendorRepository');

const requireVendorAuth = async (req, res, next) => {
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

    req.vendor = vendor;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireVendorAuth;

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { assertSessionActive } = require('../utils/sessions');
const driverRepository = require('../repositories/driverRepository');

const requireDriverAuth = async (req, res, next) => {
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

    if (payload.role !== config.delivery.jwtRole) {
      throw ApiError.forbidden('Delivery worker credentials are required.', 'DRIVER_ONLY');
    }

    const driver = await driverRepository.findById(payload.sub);
    if (!driver) {
      throw ApiError.unauthorized('Delivery worker account no longer exists.', 'INVALID_TOKEN');
    }
    // Suspended or rejected while signed in: no more access (like vendors).
    if (['suspended', 'rejected'].includes(driver.verification_status)) {
      throw ApiError.forbidden(
        `This delivery worker account was ${driver.verification_status}. Contact support.`,
        driver.verification_status === 'suspended' ? 'DRIVER_SUSPENDED' : 'DRIVER_REJECTED'
      );
    }

    // Signed out (this device, or everywhere) or password changed since.
    await assertSessionActive(payload, driver);
    req.tokenPayload = payload;
    req.driver = driver;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireDriverAuth;

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
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
      throw ApiError.forbidden('Driver credentials are required.', 'DRIVER_ONLY');
    }

    const driver = await driverRepository.findById(payload.sub);
    if (!driver) {
      throw ApiError.unauthorized('Driver account no longer exists.', 'INVALID_TOKEN');
    }

    req.driver = driver;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireDriverAuth;

const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { assertSessionActive } = require('../utils/sessions');
const customerRepository = require('../repositories/customerRepository');

const requireAuth = async (req, res, next) => {
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
        throw ApiError.unauthorized('Session expired. Please log in again.', 'TOKEN_EXPIRED');
      }
      throw ApiError.unauthorized('Invalid or malformed token.', 'INVALID_TOKEN');
    }

    const customer = await customerRepository.findById(payload.sub);
    if (!customer) {
      throw ApiError.unauthorized('Account no longer exists.', 'INVALID_TOKEN');
    }
    if (customer.is_active === false) {
      throw ApiError.forbidden('This account has been deactivated. Contact support.', 'ACCOUNT_DISABLED');
    }

    // Signed out (this device, or everywhere) or password changed since.
    await assertSessionActive(payload, customer);
    req.tokenPayload = payload;
    req.customer = customer;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireAuth;

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const adminRepository = require('../repositories/adminRepository');

const requireAdminAuth = async (req, res, next) => {
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

    if (payload.role !== config.admin.jwtRole) {
      throw ApiError.forbidden('Admin credentials are required.', 'ADMIN_ONLY');
    }

    const admin = await adminRepository.findById(payload.sub);
    if (!admin) {
      throw ApiError.unauthorized('Admin account no longer exists.', 'INVALID_TOKEN');
    }
    if (admin.is_active === false) {
      throw ApiError.forbidden('This admin account has been deactivated.', 'ADMIN_DISABLED');
    }
    if (admin.status === 'invited') {
      throw ApiError.forbidden('Accept your invitation first.', 'INVITATION_PENDING');
    }

    req.admin = admin;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireAdminAuth;

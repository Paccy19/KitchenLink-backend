const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { hashPassword, comparePassword } = require('../utils/password');
const { parseEmail, parsePassword } = require('../utils/vendorValidators');
const { serializeAdmin } = require('../utils/serializers');
const adminRepository = require('../repositories/adminRepository');

class AdminAuthService {
  async login({ email, password }) {
    const normalizedEmail = parseEmail(email);
    const rawPassword = typeof password === 'string' ? password : '';
    if (!rawPassword) {
      throw ApiError.badRequest('password is required.', {
        password: 'expected a password',
      });
    }

    const admin = await adminRepository.findByEmailWithPassword(normalizedEmail);
    if (!admin) {
      throw ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
    }

    if (admin.is_active === false) {
      throw ApiError.forbidden(
        'This admin account has been deactivated.',
        'ADMIN_DISABLED'
      );
    }

    const ok = await comparePassword(rawPassword, admin.password_hash || '');
    if (!ok) {
      throw ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
    }

    await adminRepository.touchLogin(admin._id);
    return this.#issueSession({ ...admin, last_login_at: new Date() });
  }

  me(admin) {
    return { admin: serializeAdmin(admin) };
  }

  async changePassword(admin, { current_password, new_password }) {
    const currentPassword = parsePassword(current_password, {
      field: 'current_password',
    });
    const newPassword = parsePassword(new_password, { field: 'new_password' });

    const fresh = await adminRepository.findByEmailWithPassword(admin.email);
    const ok = await comparePassword(currentPassword, fresh?.password_hash || '');
    if (!ok) {
      throw ApiError.unauthorized(
        'Current password is incorrect.',
        'INVALID_CREDENTIALS'
      );
    }

    const password_hash = await hashPassword(newPassword);
    await adminRepository.update(admin._id, { password_hash });
    return { updated: true };
  }

  /**
   * Idempotently creates the seed super admin. Used by the seeding script and
   * on first boot so a fresh database always has a way in.
   */
  async ensureSeedAdmin() {
    const email = config.admin.seedEmail;
    const existing = await adminRepository.findByEmail(email);
    if (existing) return { created: false, admin: existing };

    const password_hash = await hashPassword(config.admin.seedPassword);
    const admin = await adminRepository.create({
      name: config.admin.seedName,
      email,
      password_hash,
      role: 'super_admin',
      permissions: [],
      is_active: true,
    });
    return { created: true, admin };
  }

  #issueSession(admin) {
    const token = signToken({
      sub: String(admin._id),
      role: config.admin.jwtRole,
    });
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      admin: serializeAdmin(admin),
    };
  }
}

module.exports = new AdminAuthService();

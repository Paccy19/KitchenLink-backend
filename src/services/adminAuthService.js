const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken, signShortToken, verifyToken } = require('../utils/jwt');
const { normalizePhone } = require('../utils/validators');
const adminOtpService = require('./adminOtpService');
const { OWNER_ROLE } = require('../config/adminAccess');

const CHALLENGE_ROLE = 'admin_2fa';
// Money/security actions that need a fresh SMS code.
const ACTION_CONTEXTS = [
  'platform_withdrawal',
  'payout_destination',
  'remove_destination',
  'adjustment',
  'payout_settings',
  'disable_2fa',
  'team_change',
  'large_payment',
];
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
    if (admin.status === 'invited' && admin.is_active !== false) {
      throw ApiError.forbidden(
        'Finish setting up your account first: open the invitation email and create your password.',
        'INVITATION_PENDING'
      );
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

    const usesDefaultPassword = await this.#isDefaultPassword(admin.password_hash);

    // Team members always sign in with an SMS code.
    if (admin.role !== OWNER_ROLE && !(admin.two_factor_enabled && admin.phone)) {
      throw ApiError.forbidden(
        'Your account has no phone for sign-in codes. Ask the owner to send you a new invitation.',
        'TWO_FACTOR_REQUIRED'
      );
    }

    // Second step: a code sent to the admin's verified phone.
    if (admin.two_factor_enabled && admin.phone) {
      const sent = await adminOtpService.send(admin.phone, 'login');
      return {
        two_factor_required: true,
        challenge_token: signShortToken({ sub: String(admin._id), role: CHALLENGE_ROLE }),
        ...sent,
      };
    }

    await adminRepository.touchLogin(admin._id);
    return this.#issueSession({ ...admin, last_login_at: new Date() }, { usesDefaultPassword });
  }

  /** Completes a sign-in that required an SMS code. */
  async verifyTwoFactor({ challenge_token, code }) {
    let payload;
    try {
      payload = verifyToken(String(challenge_token || ''));
    } catch {
      throw ApiError.unauthorized('Your sign-in attempt expired. Please sign in again.', 'CHALLENGE_EXPIRED');
    }
    if (payload.role !== CHALLENGE_ROLE) {
      throw ApiError.unauthorized('Invalid sign-in attempt.', 'INVALID_CHALLENGE');
    }
    const admin = await adminRepository.findById(payload.sub);
    if (!admin || admin.is_active === false || !admin.phone) {
      throw ApiError.unauthorized('Invalid sign-in attempt.', 'INVALID_CHALLENGE');
    }
    await adminOtpService.verify(admin.phone, 'login', code);
    const withPassword = await adminRepository.findByEmailWithPassword(admin.email);
    const usesDefaultPassword = await this.#isDefaultPassword(withPassword?.password_hash);
    await adminRepository.touchLogin(admin._id);
    return this.#issueSession({ ...admin, last_login_at: new Date() }, { usesDefaultPassword });
  }

  async me(admin) {
    return {
      admin: serializeAdmin(admin, { usesDefaultPassword: await this.usesDefaultPassword(admin) }),
      // Refunds/payouts of this amount or more ask for an SMS code.
      limits: { large_money_action_rwf: config.team.largeMoneyActionRwf },
    };
  }

  async usesDefaultPassword(admin) {
    const withPassword = await adminRepository.findByEmailWithPassword(admin.email);
    return this.#isDefaultPassword(withPassword?.password_hash);
  }

  async #isDefaultPassword(hash) {
    if (!hash || !config.admin.seedPassword) return false;
    return comparePassword(config.admin.seedPassword, hash);
  }

  /* --------------------------- SMS codes (2FA) --------------------------- */

  /** Step 1 of turning on SMS codes: send a code to the new phone. */
  async startTwoFactor(admin, { phone }) {
    return adminOtpService.send(normalizePhone(phone), 'enable_2fa');
  }

  /** Step 2: prove the phone works, then require codes from now on. */
  async enableTwoFactor(admin, { phone, code }) {
    const normalized = normalizePhone(phone);
    await adminOtpService.verify(normalized, 'enable_2fa', code);
    const updated = await adminRepository.update(admin._id, { phone: normalized, two_factor_enabled: true });
    return { admin: serializeAdmin(updated) };
  }

  async disableTwoFactor(admin, { code }) {
    if (admin.role !== OWNER_ROLE) {
      throw ApiError.forbidden('SMS sign-in codes are required for team members.', 'TWO_FACTOR_REQUIRED');
    }
    if (!admin.two_factor_enabled || !admin.phone) {
      return { admin: serializeAdmin(admin) };
    }
    await adminOtpService.verify(admin.phone, 'disable_2fa', code);
    const updated = await adminRepository.update(admin._id, { two_factor_enabled: false });
    return { admin: serializeAdmin(updated) };
  }

  /** Sends a code for a money/security action to the admin's verified phone. */
  async sendActionCode(admin, { purpose }) {
    if (!ACTION_CONTEXTS.includes(purpose)) {
      throw ApiError.badRequest('purpose is invalid.', { purpose: `expected one of: ${ACTION_CONTEXTS.join(', ')}` });
    }
    this.assertTwoFactor(admin);
    return adminOtpService.send(admin.phone, purpose);
  }

  /** Verifies an action code (the admin must have a verified phone). */
  async verifyActionCode(admin, purpose, code) {
    this.assertTwoFactor(admin);
    return adminOtpService.verify(admin.phone, purpose, code);
  }

  /**
   * Refunds and payouts of config.team.largeMoneyActionRwf or more need a
   * fresh SMS code (purpose `large_payment`), whoever sends them.
   */
  async confirmLargeMoney(admin, amountRwf, code) {
    if (Number(amountRwf) < config.team.largeMoneyActionRwf) return;
    if (!code) {
      throw new ApiError(
        403,
        'ACTION_CODE_REQUIRED',
        `Amounts of ${config.team.largeMoneyActionRwf.toLocaleString('en-US')} RWF or more need the SMS code sent to your phone.`,
        { purpose: 'large_payment', large_money_action_rwf: config.team.largeMoneyActionRwf }
      );
    }
    await this.verifyActionCode(admin, 'large_payment', code);
  }

  assertTwoFactor(admin) {
    if (!admin.two_factor_enabled || !admin.phone) {
      throw ApiError.forbidden(
        'Turn on SMS codes in Settings first: money actions are confirmed with a code sent to your phone.',
        'TWO_FACTOR_REQUIRED'
      );
    }
  }

  async changePassword(admin, { current_password, new_password }) {
    const currentPassword = parsePassword(current_password, {
      field: 'current_password',
    });
    const newPassword = parsePassword(new_password, { field: 'new_password' });
    if (newPassword === config.admin.seedPassword) {
      throw ApiError.badRequest('Choose a password different from the default one.', {
        new_password: 'must not be the default password',
      });
    }

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

  #issueSession(admin, { usesDefaultPassword = false } = {}) {
    const token = signToken({
      sub: String(admin._id),
      role: config.admin.jwtRole,
    });
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      admin: serializeAdmin(admin, { usesDefaultPassword }),
    };
  }
}

module.exports = new AdminAuthService();

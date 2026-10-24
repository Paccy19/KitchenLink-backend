const config = require('../config');
const ApiError = require('../utils/ApiError');
const { revokeAllSessions } = require('../utils/sessions');
const { Admin } = require('../models');
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
    await this.#flagDefaultPassword(admin, usesDefaultPassword);

    // Second step: a code sent to the admin's verified phone (only when 2FA is on).
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
    const uses = await this.#isDefaultPassword(withPassword?.password_hash);
    await this.#flagDefaultPassword(admin, uses);
    return uses;
  }

  /** Keeps `must_change_password` in step with whether the seeded password is still in use. */
  async #flagDefaultPassword(admin, usesDefaultPassword) {
    if (Boolean(admin.must_change_password) !== usesDefaultPassword) {
      await adminRepository.update(admin._id, { must_change_password: usesDefaultPassword });
    }
  }

  async #isDefaultPassword(hash) {
    if (!hash || !config.admin.seedPassword) return false;
    return comparePassword(config.admin.seedPassword, hash);
  }

  /* --------------------------- SMS codes (2FA) --------------------------- */

  /** Step 1 of turning on SMS codes: send a code to the new phone. */
  async startTwoFactor(admin, { phone }) {
    const normalized = normalizePhone(phone);
    await this.#assertPhoneFree(admin, normalized);
    return adminOtpService.send(normalized, 'enable_2fa');
  }

  /** Step 2: prove the phone works, then require codes from now on. */
  async enableTwoFactor(admin, { phone, code }) {
    const normalized = normalizePhone(phone);
    await this.#assertPhoneFree(admin, normalized);
    await adminOtpService.verify(normalized, 'enable_2fa', code);
    const updated = await adminRepository.update(admin._id, { phone: normalized, two_factor_enabled: true });
    return { admin: serializeAdmin(updated) };
  }

  /** One phone per admin account: another team member cannot reuse it. */
  async #assertPhoneFree(admin, phone) {
    const existing = await adminRepository.findByPhone(phone);
    if (existing && String(existing._id) !== String(admin._id)) {
      throw ApiError.conflict(
        'This phone number is already used by another admin account.',
        'PHONE_ALREADY_REGISTERED'
      );
    }
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

  async changePassword(admin, { current_password, new_password, currentToken = null }) {
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
    await adminRepository.update(admin._id, { password_hash, must_change_password: false });
    // Anyone else signed in with the old password is signed out.
    await revokeAllSessions(Admin, admin._id, { keepPayload: currentToken });
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

    // Everyone can read the example password in this code, so a live server
    // never creates the first (super) admin with it.
    if (config.admin.seedPasswordIsWeak && !config.explicitDev) {
      const error = new Error(
        'no admin account exists yet. Set ADMIN_SEED_PASSWORD in .env to a private password of at least 12 characters (not the example one) to create the first admin.'
      );
      error.code = 'SEED_PASSWORD_REQUIRED';
      throw error;
    }

    const password_hash = await hashPassword(config.admin.seedPassword);
    const admin = await adminRepository.create({
      name: config.admin.seedName,
      email,
      password_hash,
      role: 'super_admin',
      permissions: [],
      is_active: true,
      // Whoever set up the server knows this password: change it on first sign-in.
      must_change_password: true,
    });
    return { created: true, admin };
  }

  #issueSession(admin, { usesDefaultPassword = false } = {}) {
    const token = signToken(
      { sub: String(admin._id), role: config.admin.jwtRole },
      { expiresIn: config.admin.jwtExpiresIn }
    );
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.admin.jwtExpiresIn,
      admin: serializeAdmin(admin, { usesDefaultPassword }),
    };
  }
}

module.exports = new AdminAuthService();

const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const { Admin, AdminLoginChallenge } = require('../models');
const { ADMIN_ROLES } = require('../models/Admin');
const { comparePassword } = require('../utils/password');
const otpGuardService = require('./otpGuardService');
const adminActionLogService = require('./adminActionLogService');
const adminAuthService = require('./adminAuthService');

const CHALLENGE_MINUTES = 5;
const MAX_ATTEMPTS = 5;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const expired = () =>
  ApiError.unauthorized('Your phone verification has expired. Sign in again with your phone number.', 'CHALLENGE_EXPIRED');
const badCredentials = () => ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');

// The same rule as requireAdminAuth: active, not still invited, a known role.
// (The first admin was created before `status` existed, so it has none.)
const mayUseAdmin = (admin) => admin.is_active !== false && admin.status !== 'invited' && ADMIN_ROLES.includes(admin.role);

/**
 * Hidden admin sign-in through the customer phone login.
 *
 *  Stage 1 (authService.verifyOtp): the normal customer sign-in code is
 *  verified. If that phone is the verified phone of an ACTIVE admin, no
 *  session is issued — only a challenge: a random token, valid 5 minutes,
 *  stored as a hash and bound to that admin and phone on the server.
 *
 *  Stage 2 (`complete`): the admin's email and password. They must belong to
 *  the very admin the phone identified — another admin's credentials fail
 *  like a wrong password. Only then is an admin session issued.
 *
 * Nothing here tells anyone who has not verified the phone that an admin
 * exists: sending a code works the same for every phone, and admin-ness is
 * only checked after the code is verified. Disabled or not-yet-accepted
 * admins are never offered stage 2 (they get the normal customer sign-in).
 *
 * A phone that is both a customer's and an admin's: the verified person is
 * shown the admin step and may choose "continue as a customer"
 * (`continueAsCustomer`), which uses the challenge up and signs them in to
 * their customer account exactly as before. The two accounts stay separate:
 * nothing here creates, changes or links admin and customer records.
 */
class AdminPhoneLoginService {
  /** The admin whose verified phone this is, if they may sign in (else null). */
  async #eligibleAdmin(phone) {
    if (!phone) return null;
    const admin = await Admin.findOne({ phone, deleted_at: null }).lean();
    if (!admin || !mayUseAdmin(admin)) return null;
    return admin;
  }

  /**
   * After a customer sign-in code was verified: a challenge for stage 2 when
   * the phone is an eligible admin's, otherwise null (normal customer sign-in).
   */
  async challengeFor(phone, { name = '' } = {}) {
    const admin = await this.#eligibleAdmin(phone);
    if (!admin) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    await AdminLoginChallenge.create({
      token_hash: hashToken(token),
      admin_id: admin._id,
      phone,
      customer_name: typeof name === 'string' ? name.trim().slice(0, 80) : '',
      expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60 * 1000),
    });
    return { challenge_token: token, expires_in_seconds: CHALLENGE_MINUTES * 60 };
  }

  async #openChallenge(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) throw expired();
    const challenge = await AdminLoginChallenge.findOne({
      token_hash: hashToken(rawToken),
      used_at: null,
      expires_at: { $gt: new Date() },
    }).lean();
    if (!challenge) throw expired();
    return challenge;
  }

  /** Uses the challenge up (once only, even if two requests race). */
  async #consume(challenge, usedFor) {
    const used = await AdminLoginChallenge.findOneAndUpdate(
      { _id: challenge._id, used_at: null },
      { $set: { used_at: new Date(), used_for: usedFor } },
      { returnDocument: 'after' }
    ).lean();
    if (!used) throw expired();
    return used;
  }

  async #fail(challenge, admin, reason, req) {
    const updated = await AdminLoginChallenge.findOneAndUpdate(
      { _id: challenge._id, used_at: null },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' }
    ).lean();
    if (updated && updated.attempts >= MAX_ATTEMPTS) {
      await AdminLoginChallenge.updateOne({ _id: challenge._id, used_at: null }, { $set: { used_at: new Date(), used_for: 'too_many_attempts' } });
    }
    if (admin) {
      await adminActionLogService.record(
        admin,
        { action: 'auth.login_failed', target_type: 'admin', target_id: admin._id, target_label: admin.email, metadata: { method: 'phone_otp_password', reason } },
        req
      );
    }
  }

  /**
   * Stage 2: the admin's email and password, for the admin the verified phone
   * belongs to. Returns the admin session ({ token, admin, … }).
   */
  async complete({ challenge_token, email, password } = {}, req = null) {
    const challenge = await this.#openChallenge(challenge_token);
    const typedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const typedPassword = typeof password === 'string' ? password : '';
    if (!typedEmail || !typedPassword) {
      throw ApiError.badRequest('Enter your administrator email and password.', { email: 'required', password: 'required' });
    }

    const admin = await Admin.findOne({ _id: challenge.admin_id, deleted_at: null }).select('+password_hash').lean();
    // The admin lost access (or changed phone) since the code was verified.
    if (!admin || !mayUseAdmin(admin) || admin.phone !== challenge.phone) {
      await this.#consume(challenge, 'admin').catch(() => null);
      throw expired();
    }
    // Same lockout as the email + password sign-in.
    await otpGuardService.assertNotLocked(admin.email, 'admin-login');

    // Another admin's email (or any other) fails exactly like a wrong password.
    const emailMatches = typedEmail === admin.email;
    const passwordMatches = await comparePassword(typedPassword, admin.password_hash || '');
    if (!emailMatches || !passwordMatches) {
      await this.#fail(challenge, admin, emailMatches ? 'wrong_password' : 'wrong_email', req);
      await otpGuardService.recordFailedAttempt(admin.email, 'admin-login');
      throw badCredentials();
    }

    await this.#consume(challenge, 'admin');
    await otpGuardService.clearFailures(admin.email, 'admin-login');
    const { password_hash: passwordHash, ...safeAdmin } = admin;
    const session = await adminAuthService.issuePhoneLoginSession(safeAdmin, passwordHash);
    await adminActionLogService.record(
      safeAdmin,
      { action: 'auth.login', target_type: 'admin', target_id: admin._id, target_label: admin.email, metadata: { method: 'phone_otp_password' } },
      req
    );
    return session;
  }

  /**
   * The verified person chose to sign in as a customer instead: the challenge
   * is used up and they get the ordinary customer session for this phone.
   */
  async continueAsCustomer({ challenge_token, name } = {}) {
    const challenge = await this.#openChallenge(challenge_token);
    await this.#consume(challenge, 'customer');
    // Required here: authService needs this service (no import cycle at load).
    // eslint-disable-next-line global-require
    return require('./authService').customerSession(challenge.phone, { name: name ?? challenge.customer_name });
  }
}

module.exports = new AdminPhoneLoginService();
module.exports.CHALLENGE_MINUTES = CHALLENGE_MINUTES;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;

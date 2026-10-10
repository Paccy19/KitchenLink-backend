const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone } = require('../utils/validators');
const { parseEmail, parsePassword, parseRequiredText } = require('../utils/vendorValidators');
const { parseVehicleType } = require('../utils/deliveryValidators');
const { serializeDriverAccount } = require('../utils/serializers');
const { hashPassword, comparePassword } = require('../utils/password');
const driverRepository = require('../repositories/driverRepository');
const otpRepository = require('../repositories/otpRepository');

class DriverAuthService {
  /**
   * Registers a new driver. Accounts are immediately usable (approved) so the
   * OTP sign-in flow works right away, mirroring the vendor experience.
   */
  async register(body = {}) {
    const name = parseRequiredText(body.name, { field: 'name', min: 2, max: 120 });
    const phone = normalizePhone(body.phone);
    const vehicleType = parseVehicleType(body.vehicle_type);
    const plateNumber =
      body.plate_number !== undefined && body.plate_number !== null
        ? String(body.plate_number).trim().slice(0, 20)
        : '';
    const email =
      body.email !== undefined && body.email !== null && String(body.email).trim() !== ''
        ? parseEmail(body.email)
        : undefined;

    const existing = await driverRepository.findByPhone(phone);
    if (existing) {
      throw ApiError.conflict(
        'A driver with this phone number is already registered.',
        'PHONE_ALREADY_REGISTERED'
      );
    }

    const driver = await driverRepository.create({
      name,
      phone,
      vehicle_type: vehicleType,
      plate_number: plateNumber,
      ...(email ? { email } : {}),
      verification_status: 'approved',
      is_online: false,
      status: 'offline',
      is_available: false,
      active_deliveries_count: 0,
      completed_deliveries: 0,
      total_earnings_rwf: 0,
    });

    return { driver: serializeDriverAccount(driver), next: 'login' };
  }

  async sendLoginOtp({ phone }) {
    const normalizedPhone = normalizePhone(phone);
    const driver = await driverRepository.findByPhone(normalizedPhone);
    if (!driver) {
      throw ApiError.notFound(
        'No driver account is registered with this phone number.',
        'DRIVER_NOT_FOUND'
      );
    }
    this.#assertCanLogin(driver);

    const now = Date.now();
    const lastSentAt = await otpRepository.lastSentAt(normalizedPhone);
    if (
      lastSentAt &&
      now - new Date(lastSentAt).getTime() <
        config.auth.otpResendCooldownSeconds * 1000
    ) {
      throw ApiError.tooMany(
        'A code was just sent. Please wait before requesting another.',
        'OTP_RESEND_TOO_SOON',
        { retry_after_seconds: config.auth.otpResendCooldownSeconds }
      );
    }

    const recentCount = await otpRepository.countRecent(
      normalizedPhone,
      new Date(now - config.auth.otpRateWindowMinutes * 60 * 1000)
    );
    if (recentCount >= config.auth.otpRateMaxSends) {
      throw ApiError.tooMany(
        'Too many code requests. Please try again later.',
        'OTP_RATE_LIMITED',
        { retry_after_minutes: config.auth.otpRateWindowMinutes }
      );
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await otpRepository.create({
      phoneNumber: normalizedPhone,
      purpose: 'driver',
      code,
      name: driver.name,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });

    const isDev = config.env !== 'production';
    if (isDev) console.log(`[driver otp] ${normalizedPhone} -> ${code}`);

    return {
      phone_number: normalizedPhone,
      expires_in_seconds: config.auth.otpTtlMinutes * 60,
      ...(isDev ? { dev_otp: code } : {}),
    };
  }

  async verifyLoginOtp({ phone, code }) {
    const normalizedPhone = normalizePhone(phone);
    const rawCode = typeof code === 'string' ? code.trim() : String(code ?? '');
    if (!/^\d{6}$/.test(rawCode)) {
      throw ApiError.badRequest('code must be a 6-digit number.', {
        code: 'expected 6 digits',
      });
    }

    const otp = await otpRepository.findLatestActive(normalizedPhone, 'driver');
    if (!otp) {
      const latest = await otpRepository.findLatestAny(normalizedPhone, 'driver');
      const expired = latest && latest.expires_at < new Date();
      throw ApiError.badRequest(
        expired
          ? 'Code expired. Request a new one.'
          : 'No active code for this phone number. Request a new one.',
        expired ? 'OTP_EXPIRED' : 'OTP_NOT_FOUND'
      );
    }

    if (otp.attempts >= config.auth.otpMaxAttempts) {
      await otpRepository.consume(otp._id);
      throw ApiError.tooMany(
        'Too many incorrect attempts. Request a new code.',
        'OTP_TOO_MANY_ATTEMPTS'
      );
    }

    if (otp.code !== rawCode) {
      await otpRepository.incrementAttempts(otp._id);
      const remaining = config.auth.otpMaxAttempts - (otp.attempts + 1);
      throw ApiError.badRequest('Incorrect code.', 'OTP_INVALID', {
        code: 'incorrect code',
        attempts_remaining: Math.max(remaining, 0),
      });
    }

    await otpRepository.consume(otp._id);
    const driver = await driverRepository.findByPhone(normalizedPhone);
    if (!driver) {
      throw ApiError.notFound(
        'This driver account is no longer available.',
        'DRIVER_NOT_FOUND'
      );
    }
    this.#assertCanLogin(driver);
    await driverRepository.touchLogin(driver._id);
    return this.#issueSession(driver);
  }

  me(driver) {
    return { driver: serializeDriverAccount(driver) };
  }

  async changePassword(driver, { current_password, new_password }) {
    const currentPassword = parsePassword(current_password, {
      field: 'current_password',
    });
    const newPassword = parsePassword(new_password, { field: 'new_password' });

    const fresh = await driverRepository.findByIdWithPassword(driver._id);
    const ok = await comparePassword(currentPassword, fresh?.password_hash || '');
    if (!ok) {
      throw ApiError.unauthorized(
        'Current password is incorrect.',
        'INVALID_CREDENTIALS'
      );
    }

    const password_hash = await hashPassword(newPassword);
    await driverRepository.update(driver._id, { password_hash });
    return { updated: true };
  }

  #assertCanLogin(driver) {
    if (driver.verification_status === 'rejected') {
      throw ApiError.forbidden(
        'This driver account was rejected. Contact support.',
        'DRIVER_REJECTED'
      );
    }
  }

  #issueSession(driver) {
    const token = signToken({
      sub: String(driver._id),
      role: config.delivery.jwtRole,
    });
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      driver: serializeDriverAccount({ ...driver, last_login_at: new Date() }),
    };
  }
}

module.exports = new DriverAuthService();

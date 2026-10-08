const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone, parseName } = require('../utils/validators');
const customerRepository = require('../repositories/customerRepository');
const otpRepository = require('../repositories/otpRepository');

const serializeCustomer = (customer) => ({
  id: String(customer._id),
  name: customer.name,
  phone_number: customer.phone_number,
});

class AuthService {
  async sendOtp({ phone_number, name }) {
    const phone = normalizePhone(phone_number);
    const existing = await customerRepository.findByPhone(phone);
    const pendingName = existing ? null : parseName(name);

    const now = Date.now();
    const lastSentAt = await otpRepository.lastSentAt(phone);
    if (lastSentAt && now - new Date(lastSentAt).getTime() < config.auth.otpResendCooldownSeconds * 1000) {
      throw ApiError.tooMany(
        'A code was just sent. Please wait before requesting another.',
        'OTP_RESEND_TOO_SOON',
        { retry_after_seconds: config.auth.otpResendCooldownSeconds }
      );
    }

    const recentCount = await otpRepository.countRecent(
      phone,
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
      phoneNumber: phone,
      code,
      name: pendingName || undefined,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });

    // No SMS provider is wired up yet: in development the code is returned
    // directly and also logged so the flow can be exercised end to end.
    const isDev = config.env !== 'production';
    if (isDev) console.log(`[otp] ${phone} -> ${code}`);

    return {
      phone_number: phone,
      expires_in_seconds: config.auth.otpTtlMinutes * 60,
      requires_name: !existing,
      ...(isDev ? { dev_otp: code } : {}),
    };
  }

  async verifyOtp({ phone_number, code, name }) {
    const phone = normalizePhone(phone_number);
    const rawCode = typeof code === 'string' ? code.trim() : String(code ?? '');
    if (!/^\d{6}$/.test(rawCode)) {
      throw ApiError.badRequest('code must be a 6-digit number.', {
        code: 'expected 6 digits',
      });
    }

    const otp = await otpRepository.findLatestActive(phone);
    if (!otp) {
      const latest = await otpRepository.findLatestAny(phone);
      throw ApiError.badRequest(
        latest && latest.expires_at < new Date()
          ? 'Code expired. Request a new one.'
          : 'No active code for this phone number. Request a new one.',
        latest && latest.expires_at < new Date() ? 'OTP_EXPIRED' : 'OTP_NOT_FOUND'
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

    let customer = await customerRepository.findByPhone(phone);
    if (!customer) {
      const customerName = parseName(name) ?? (otp.name ? parseName(otp.name) : null);
      if (!customerName) {
        throw ApiError.badRequest(
          'name is required to complete registration.',
          { name: 'expected a non-empty string' }
        );
      }
      customer = await customerRepository.create({
        name: customerName,
        phoneNumber: phone,
      });
    } else {
      await customerRepository.touchLogin(customer._id);
      customer = { ...customer, last_login_at: new Date() };
    }

    const token = signToken({ sub: String(customer._id), phone: customer.phone_number });

    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      customer: serializeCustomer(customer),
    };
  }

  async me(customer) {
    return { customer: serializeCustomer(customer) };
  }
}

module.exports = new AuthService();

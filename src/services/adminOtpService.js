const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { sendSms } = require('../utils/sms');
const otpRepository = require('../repositories/otpRepository');
const otpGuardService = require('./otpGuardService');

/**
 * One-time codes sent to an admin's phone. Each code is bound to a `context`
 * (what it authorizes), so a code requested for one action cannot approve
 * another.
 */
const CONTEXT_LABELS = {
  login: 'sign in',
  enable_2fa: 'turn on SMS codes',
  disable_2fa: 'turn off SMS codes',
  platform_withdrawal: 'withdraw platform commission',
  payout_destination: 'add a payout account',
  remove_destination: 'remove a payout account',
  adjustment: 'record a books adjustment',
  payout_settings: 'save your payout settings',
  team_change: 'change who can access the admin panel',
  large_payment: 'confirm a large refund or payout',
  accept_invite: 'finish joining the admin team',
};
const CONTEXTS = Object.keys(CONTEXT_LABELS);

const maskPhone = (phone) => (phone ? `${'•'.repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}` : '');

class AdminOtpService {
  get contexts() {
    return CONTEXTS;
  }

  maskPhone(phone) {
    return maskPhone(phone);
  }

  async send(phone, context) {
    if (!CONTEXTS.includes(context)) {
      throw ApiError.badRequest('purpose is invalid.', { purpose: `expected one of: ${CONTEXTS.join(', ')}` });
    }
    const now = Date.now();
    // Resend gap per action, so e.g. a setup code never blocks the sign-in code.
    const lastSentAt = await otpRepository.lastSentAt(phone, context);
    if (lastSentAt && now - new Date(lastSentAt).getTime() < 30 * 1000) {
      throw ApiError.tooMany('A code was just sent. Please wait a moment before requesting another.', 'OTP_RESEND_TOO_SOON', {
        retry_after_seconds: 30,
      });
    }
    // The owner may confirm several money actions in one sitting.
    const recent = await otpRepository.countRecent(phone, new Date(now - 10 * 60 * 1000));
    if (recent >= 10) {
      throw ApiError.tooMany('Too many code requests. Please try again later.', 'OTP_RATE_LIMITED');
    }

    await otpGuardService.beforeSend(phone, 'admin');

    const code = String(crypto.randomInt(100000, 1000000));
    await otpRepository.create({
      phoneNumber: phone,
      purpose: 'admin',
      context,
      code,
      expiresAt: new Date(now + config.admin.otpTtlMinutes * 60 * 1000),
    });
    await sendSms(phone, `KitchenLink admin: your code to ${CONTEXT_LABELS[context]} is ${code}. Never share it.`);

    const isDev = config.explicitDev;
    if (isDev) console.log(`[admin otp] ${context} ${phone} -> ${code}`);
    return {
      sent_to: maskPhone(phone),
      expires_in_seconds: config.admin.otpTtlMinutes * 60,
      ...(isDev ? { dev_otp: code } : {}),
    };
  }

  /** Throws unless `code` is the latest unused code for this phone + context. */
  async verify(phone, context, rawCode) {
    const code = typeof rawCode === 'string' ? rawCode.trim() : String(rawCode ?? '');
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, 'OTP_REQUIRED', 'Enter the 6-digit code sent to your phone.', { otp_code: 'expected 6 digits' });
    }
    await otpGuardService.assertNotLocked(phone, 'admin');
    const otp = await otpRepository.findLatestActive(phone, 'admin', context);
    if (!otp) {
      throw new ApiError(400, 'OTP_NOT_FOUND', 'No active code. Request a new one.');
    }
    await otpGuardService.check(otp, code, phone, 'admin');
    return true;
  }
}

module.exports = new AdminOtpService();

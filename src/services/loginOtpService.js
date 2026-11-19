const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const otpRepository = require('../repositories/otpRepository');
const otpGuardService = require('./otpGuardService');
const { sendCodeSms } = require('../utils/sms');
const { sendEmail, escapeHtml } = require('../utils/email');
const { maskIdentifier } = require('../utils/identifier');

/**
 * One-time codes for customers, kitchens and delivery workers, sent to a
 * phone (SMS) or an email address. Both channels get the same rules:
 * 6 random digits stored only as a keyed hash, a few minutes' life, single
 * use, 5 tries per code, a resend gap, a per-window cap, the daily cap and
 * lockouts (otpGuardService), and a new code cancels the earlier ones.
 *
 * Showing the code (`dev_otp`): SMS codes only, and only on a server whose
 * .env says NODE_ENV=development (or test), because no SMS gateway is
 * connected yet. Email codes are never shown, logged or returned anywhere:
 * they only go to the inbox.
 *
 * Delivery is the only channel-specific part (`#deliver`), so a real SMS
 * gateway (utils/sms.js) or another email service plugs in without touching
 * the sign-in flows.
 */
const LABELS = { customer: 'sign-in', vendor: 'kitchen sign-in', driver: 'delivery worker sign-in' };

class LoginOtpService {
  /**
   * @param {{ identifier: {type:'phone'|'email', value:string}, purpose: 'customer'|'vendor'|'driver',
   *           context?: string, name?: string, registrationPhone?: string, message?: string }} options
   */
  async send({ identifier, purpose, context = 'login', name, registrationPhone, message, label }) {
    const key = identifier.value;
    const channel = identifier.type === 'email' ? 'email' : 'sms';
    const now = Date.now();

    const lastSentAt = await otpRepository.lastSentAt(key);
    if (lastSentAt && now - new Date(lastSentAt).getTime() < config.auth.otpResendCooldownSeconds * 1000) {
      throw ApiError.tooMany('A code was just sent. Please wait before requesting another.', 'OTP_RESEND_TOO_SOON', {
        retry_after_seconds: config.auth.otpResendCooldownSeconds,
      });
    }
    const recentCount = await otpRepository.countRecent(key, new Date(now - config.auth.otpRateWindowMinutes * 60 * 1000));
    if (recentCount >= config.auth.otpRateMaxSends) {
      throw ApiError.tooMany('Too many code requests. Please try again later.', 'OTP_RATE_LIMITED', {
        retry_after_minutes: config.auth.otpRateWindowMinutes,
      });
    }
    // Locked-out phones/emails get no codes; at most a set number a day.
    await otpGuardService.beforeSend(key, purpose);

    await otpRepository.invalidateActive(key, purpose, context);
    const code = String(crypto.randomInt(100000, 1000000));
    const created = await otpRepository.create({
      phoneNumber: key,
      purpose,
      context,
      channel,
      code,
      name,
      registrationPhone,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });
    await this.#deliver(channel, key, code, { onFail: () => otpRepository.remove(created._id), label: label || LABELS[purpose] || 'sign-in', message });

    const showCode = channel === 'sms' && config.explicitDev;
    if (showCode) console.log(`[${purpose} otp] ${key} -> ${code}`);
    return {
      channel,
      identifier_type: identifier.type,
      sent_to: maskIdentifier(identifier),
      expires_in_seconds: config.auth.otpTtlMinutes * 60,
      resend_after_seconds: config.auth.otpResendCooldownSeconds,
      ...(showCode ? { dev_otp: code } : {}),
    };
  }

  /** Throws unless `code` is the latest unused code for this identifier and use; returns the code record. */
  async verify({ identifier, purpose, context = ['login', ''], code }) {
    const key = identifier.value;
    const rawCode = typeof code === 'string' ? code.trim() : String(code ?? '');
    if (!/^\d{6}$/.test(rawCode)) {
      throw ApiError.badRequest('code must be a 6-digit number.', { code: 'expected 6 digits' });
    }
    await otpGuardService.assertNotLocked(key, purpose);
    const otp = await otpRepository.findLatestActive(key, purpose, context);
    if (!otp) {
      const latest = await otpRepository.findLatestAny(key, purpose, context);
      const expired = latest && latest.expires_at < new Date() && !latest.consumed_at;
      throw new ApiError(
        400,
        expired ? 'OTP_EXPIRED' : 'OTP_NOT_FOUND',
        expired ? 'Code expired. Request a new one.' : 'No active code. Request a new one.'
      );
    }
    // Counts the try atomically, locks out after too many wrong codes, and
    // uses the code up when it is right (so it can't be used twice).
    await otpGuardService.check(otp, rawCode, key, purpose);
    return otp;
  }

  async #deliver(channel, to, code, { onFail, label, message }) {
    const minutes = config.auth.otpTtlMinutes;
    if (channel === 'sms') {
      await sendCodeSms(to, message ? message(code) : `KitchenLink: your ${label} code is ${code}. It expires in ${minutes} minutes. Never share it.`, { onFail });
      return;
    }
    const text = `Your KitchenLink ${label} code is ${code}.\n\nIt expires in ${minutes} minutes and works once. Never share it: KitchenLink staff will never ask for it.\n\nIf you did not ask for this code, ignore this email.`;
    const result = await sendEmail({
      to,
      sensitive: true,
      subject: `Your KitchenLink ${label} code`,
      text,
      html: `<p>Your KitchenLink ${escapeHtml(label)} code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p style="color:#666">It expires in ${minutes} minutes and works once. Never share it: KitchenLink staff will never ask for it. If you did not ask for this code, ignore this email.</p>`,
    });
    if (result.status !== 'sent') {
      // Never fall back to showing the code: the email must really leave.
      await onFail().catch(() => null);
      console.error(`[email] ${label} code not delivered: ${result.status}`);
      throw new ApiError(503, 'EMAIL_NOT_SENT', "We couldn't email your code right now. Try again in a moment, or sign in with your phone number.");
    }
  }
}

module.exports = new LoginOtpService();

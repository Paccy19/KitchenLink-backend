const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone, parseName } = require('../utils/validators');
const { parseEmail } = require('../utils/vendorValidators');
const { resolveImageUrl } = require('../utils/uploads');
const customerRepository = require('../repositories/customerRepository');
const vendorRepository = require('../repositories/vendorRepository');
const driverRepository = require('../repositories/driverRepository');
const otpRepository = require('../repositories/otpRepository');
const otpGuardService = require('./otpGuardService');
const { sendCodeSms } = require('../utils/sms');

const serializeCustomer = (customer) => ({
  id: String(customer._id),
  name: customer.name,
  phone_number: customer.phone_number,
  email: customer.email || null,
  profile_image_url: customer.profile_image_url || null,
});

/**
 * A name compared the way people write it: "  UWASE  aline" and "Aline Uwase"
 * are the same (case, spacing, accents and word order don't matter).
 */
const nameKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');

/**
 * The kitchen owner and delivery worker registered with this phone, with the
 * name each registered under (the owner's own name for a kitchen).
 */
async function linkedAccounts(phone) {
  const [vendor, driver] = await Promise.all([
    vendorRepository.findByPhone(phone),
    driverRepository.findByPhone(phone),
  ]);
  return [
    vendor && { role: 'kitchen', name: vendor.owner_name || vendor.name },
    driver && { role: 'delivery worker', name: driver.name },
  ].filter((account) => account && account.name);
}

/**
 * A kitchen owner or delivery worker signing in as a customer must give the
 * same name they registered with, so the customer account is known to be
 * theirs. Returns the registered name to use (null for an ordinary phone).
 * The error never reveals the registered name.
 */
async function assertLinkedName(phone, name) {
  const accounts = await linkedAccounts(phone);
  if (!accounts.length) return null;
  const roles = accounts.map((account) => account.role).join(' and ');
  const given = nameKey(name);
  if (!given) {
    throw new ApiError(
      400,
      'NAME_REQUIRED',
      `This phone number is registered as a ${roles} on KitchenLink. Enter the full name you registered with.`,
      { name: 'required for this phone number' }
    );
  }
  if (accounts.some((account) => nameKey(account.name) !== given)) {
    throw new ApiError(
      400,
      'NAME_DOES_NOT_MATCH',
      `This phone number is registered as a ${roles} on KitchenLink. Enter the same full name you used when you registered as a ${roles}.`,
      { name: 'does not match the registered name' }
    );
  }
  return accounts[0].name;
}

class AuthService {
  async sendOtp({ phone_number, name }) {
    const phone = normalizePhone(phone_number);
    const existing = await customerRepository.findByPhone(phone);
    // Checked before any code is sent: a wrong name gets no SMS.
    const registeredName = await assertLinkedName(phone, name);
    const pendingName = existing ? null : registeredName || parseName(name);

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

    // Locked-out phones get no codes; at most a set number a day.
    await otpGuardService.beforeSend(phone, 'customer');

    const code = String(crypto.randomInt(100000, 1000000));
    const created = await otpRepository.create({
      phoneNumber: phone,
      code,
      name: pendingName || undefined,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });

    await sendCodeSms(
      phone,
      `KitchenLink: your sign-in code is ${code}. It expires in ${config.auth.otpTtlMinutes} minutes. Never share it.`,
      { onFail: () => otpRepository.remove(created._id) }
    );

    // Only a server whose .env explicitly says development/test shows the code
    // (in the console and the response) so the flow can be tried without SMS.
    const isDev = config.explicitDev;
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

    await otpGuardService.assertNotLocked(phone, 'customer');
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

    // Counts the try atomically, locks the phone out after too many wrong
    // codes, and uses the code up when it is right.
    await otpGuardService.check(otp, rawCode, phone, 'customer');

    // Same rule as when the code was sent (the name may be resent here).
    const registeredName = await assertLinkedName(phone, name ?? otp.name);

    let customer = await customerRepository.findByPhone(phone);
    if (!customer) {
      // A kitchen owner or delivery worker gets their registered name.
      const customerName = registeredName || parseName(name) || (otp.name ? parseName(otp.name) : null);
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

  async updateProfile(customer, body = {}, file) {
    const payload = {};

    if (body.name !== undefined) {
      payload.name = parseName(body.name);
    }

    if (body.phone_number !== undefined) {
      const phone = normalizePhone(body.phone_number);
      const existing = await customerRepository.findByPhone(phone);
      if (existing && String(existing._id) !== String(customer._id)) {
        throw ApiError.conflict(
          'A customer with this phone number is already registered.',
          'PHONE_ALREADY_REGISTERED'
        );
      }
      payload.phone_number = phone;
    }

    // Optional email: unique among customers; an empty value removes it.
    const unset = [];
    if (body.email !== undefined) {
      if (body.email === null || String(body.email).trim() === '') {
        unset.push('email');
      } else {
        const email = parseEmail(body.email);
        const existing = await customerRepository.findByEmail(email);
        if (existing && String(existing._id) !== String(customer._id)) {
          throw ApiError.conflict(
            'A customer with this email is already registered.',
            'EMAIL_ALREADY_REGISTERED'
          );
        }
        payload.email = email;
      }
    }

    const profileImageUrl = await resolveImageUrl({
      file,
      image_url: body.profile_image_url,
      image_base64: body.profile_image_base64,
    });
    if (profileImageUrl !== undefined) payload.profile_image_url = profileImageUrl;

    if (Object.keys(payload).length === 0 && unset.length === 0) {
      throw ApiError.badRequest('No supported profile fields were provided.', {
        body: 'expected name, phone_number, email or profile_image',
      });
    }

    const updated = await customerRepository.update(customer._id, payload, { unset });
    return { customer: serializeCustomer(updated) };
  }

  /** Records the customer's current GPS position (sent while location tracking is on). */
  async updateLocation(customer, body = {}) {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      throw ApiError.badRequest('latitude and longitude must be valid coordinates.', {
        latitude: 'expected a number between -90 and 90',
        longitude: 'expected a number between -180 and 180',
      });
    }
    const accuracy = Number(body.accuracy_m);
    const accuracyM = Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;

    const updated = await customerRepository.updateLocation(customer._id, {
      latitude,
      longitude,
      accuracyM,
    });
    return {
      recorded: true,
      recorded_at: updated?.last_location_at ?? new Date(),
    };
  }
}

module.exports = new AuthService();

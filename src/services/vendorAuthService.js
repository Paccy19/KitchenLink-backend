const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { revokeAllSessions } = require('../utils/sessions');
const { Vendor } = require('../models');
const { signToken } = require('../utils/jwt');
const { NAME_MAX_LENGTH, capitalizeName, normalizePhone, parseDeliveryLocation } = require('../utils/validators');
const {
  parseEmail,
  parsePassword,
  parseRequiredText,
  parseVendorType,
  parseJsonField,
  parseOperatingHours,
  parsePaymentInformation,
  bindPayoutToPhone,
  parseFoodCategoryTokens,
  parseVerificationDocuments,
} = require('../utils/vendorValidators');
const { serializeVendorAccount } = require('../utils/serializers');
const { hashPassword, comparePassword } = require('../utils/password');
const { privateRef, resolveImageUrl } = require('../utils/uploads');
const vendorRepository = require('../repositories/vendorRepository');
const categoryRepository = require('../repositories/categoryRepository');
const otpRepository = require('../repositories/otpRepository');
const otpGuardService = require('./otpGuardService');
const { sendCodeSms } = require('../utils/sms');
const notificationService = require('./notificationService');
const { assertVendorNotBlocked } = require('../utils/vendorAccess');

class VendorAuthService {
  /**
   * Registers a new vendor. Accounts start as `pending` verification and are
   * hidden from discovery (`is_active: false`) until an admin approves them.
   */
  async register(body = {}, files = {}) {
    const name = parseRequiredText(body.name, { field: 'name', min: 2, max: NAME_MAX_LENGTH });
    const ownerName = capitalizeName(
      parseRequiredText(body.owner_name, {
        field: 'owner_name',
        min: 2,
        max: NAME_MAX_LENGTH,
      })
    );
    const vendorType = parseVendorType(body.vendor_type);
    const phone = normalizePhone(body.phone);
    const description = parseRequiredText(body.description, {
      field: 'description',
      min: 10,
      max: 1000,
    });

    const locationRaw = parseJsonField(body.location, 'location') || {
      address: body.address,
      neighborhood: body.neighborhood,
      latitude: body.latitude,
      longitude: body.longitude,
    };
    const location = parseDeliveryLocation(locationRaw);

    const operatingHours = parseOperatingHours(body.operating_hours);
    // Mobile-money payouts must use the phone the kitchen registers with.
    const paymentInformation = bindPayoutToPhone(parsePaymentInformation(body.payment_information), phone);
    const { ids: categoryIds, names: categoryNames } = await this.#resolveCategories(
      parseFoodCategoryTokens(body.food_categories)
    );
    const documents = this.#buildDocuments(files, body);

    const bannerImageUrl = await resolveImageUrl({
      file: files.banner_image && files.banner_image[0],
      image_url: body.banner_image_url,
      image_base64: body.banner_image_base64,
    });

    const existing = await vendorRepository.findByPhone(phone);
    if (existing) {
      throw ApiError.conflict(
        'A vendor with this phone number is already registered.',
        'PHONE_ALREADY_REGISTERED'
      );
    }
    const email =
      body.email !== undefined && body.email !== null && String(body.email).trim() !== ''
        ? parseEmail(body.email)
        : undefined;
    if (email && (await vendorRepository.findByEmail(email))) {
      throw ApiError.conflict(
        'A vendor with this email is already registered.',
        'EMAIL_ALREADY_REGISTERED'
      );
    }

    const vendor = await vendorRepository.create({
      ...(email ? { email } : {}),
      name,
      vendor_type: vendorType,
      owner_name: ownerName,
      description,
      phone,
      location: {
        type: 'Point',
        coordinates: [location.longitude, location.latitude],
      },
      address: location.address,
      neighborhood: location.neighborhood || '',
      food_category_ids: categoryIds,
      food_categories: categoryNames,
      operating_hours: operatingHours,
      payment_information: paymentInformation,
      verification_documents: documents,
      verification_status: 'pending',
      is_active: false,
      // Closed (hidden from the map) until the vendor opens the store.
      is_open: false,
      delivery_available: true,
      available_balance: 0,
      total_sales: 0,
      ...(bannerImageUrl ? { banner_image_url: bannerImageUrl } : {}),
    });

    notificationService
      .notifyAdmin({
        type: 'vendor_application',
        title: 'New vendor application',
        body: `${name} (${vendorType}) applied to join the marketplace and needs verification.`,
        link: `/admin-dashboard/vendors?vendor=${vendor._id}`,
        data: { vendor_id: String(vendor._id), vendor_name: name },
      })
      .catch(() => null);

    return { vendor: serializeVendorAccount(vendor), next: 'login' };
  }

  async sendLoginOtp({ phone }) {
    const normalizedPhone = normalizePhone(phone);
    const vendor = await vendorRepository.findByPhone(normalizedPhone);
    if (!vendor) {
      throw ApiError.notFound(
        'No vendor account is registered with this phone number.',
        'VENDOR_NOT_FOUND'
      );
    }
    this.#assertCanLogin(vendor);

    const now = Date.now();
    const lastSentAt = await otpRepository.lastSentAt(normalizedPhone);
    if (lastSentAt && now - new Date(lastSentAt).getTime() < config.auth.otpResendCooldownSeconds * 1000) {
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

    // Locked-out phones get no codes; at most a set number a day.
    await otpGuardService.beforeSend(normalizedPhone, 'vendor');

    const code = String(crypto.randomInt(100000, 1000000));
    const created = await otpRepository.create({
      phoneNumber: normalizedPhone,
      purpose: 'vendor',
      code,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });

    await sendCodeSms(
      normalizedPhone,
      `KitchenLink: your sign-in code is ${code}. It expires in ${config.auth.otpTtlMinutes} minutes. Never share it.`,
      { onFail: () => otpRepository.remove(created._id) }
    );

    // Only a server whose .env explicitly says development/test shows the code
    // (in the console and the response) so the flow can be tried without SMS.
    const isDev = config.explicitDev;
    if (isDev) console.log(`[vendor otp] ${normalizedPhone} -> ${code}`);

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

    await otpGuardService.assertNotLocked(normalizedPhone, 'vendor');
    const otp = await otpRepository.findLatestActive(normalizedPhone, 'vendor');
    if (!otp) {
      const latest = await otpRepository.findLatestAny(normalizedPhone, 'vendor');
      throw ApiError.badRequest(
        latest && latest.expires_at < new Date()
          ? 'Code expired. Request a new one.'
          : 'No active code for this phone number. Request a new one.',
        latest && latest.expires_at < new Date() ? 'OTP_EXPIRED' : 'OTP_NOT_FOUND'
      );
    }

    // Counts the try atomically, locks the phone out after too many wrong
    // codes, and uses the code up when it is right.
    await otpGuardService.check(otp, rawCode, normalizedPhone, 'vendor');
    const vendor = await vendorRepository.findByPhone(normalizedPhone);
    if (!vendor) {
      throw ApiError.notFound(
        'This vendor account is no longer available.',
        'VENDOR_NOT_FOUND'
      );
    }
    this.#assertCanLogin(vendor);
    await vendorRepository.touchLogin(vendor._id);
    return this.#issueSession(vendor);
  }

  me(vendor) {
    return { vendor: serializeVendorAccount(vendor) };
  }

  async changePassword(vendor, { current_password, new_password, currentToken = null }) {
    const currentPassword = parsePassword(current_password, {
      field: 'current_password',
    });
    const newPassword = parsePassword(new_password, { field: 'new_password' });

    const fresh = await vendorRepository.findByEmailWithPassword(vendor.email);
    const ok = await comparePassword(currentPassword, fresh?.password_hash || '');
    if (!ok) {
      throw ApiError.unauthorized(
        'Current password is incorrect.',
        'INVALID_CREDENTIALS'
      );
    }

    const password_hash = await hashPassword(newPassword);
    await vendorRepository.update(vendor._id, { password_hash });
    // Anyone else signed in with the old password is signed out.
    await revokeAllSessions(Vendor, vendor._id, { keepPayload: currentToken });
    return { updated: true };
  }

  #assertCanLogin(vendor) {
    assertVendorNotBlocked(vendor);
  }

  #issueSession(vendor) {
    const token = signToken({
      sub: String(vendor._id),
      role: config.vendor.jwtRole,
    });
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      vendor: serializeVendorAccount({ ...vendor, last_login_at: new Date() }),
    };
  }

  async #resolveCategories(tokens) {
    const ids = [];
    const names = [];
    for (const token of tokens) {
      let category = null;
      if (mongoose.isValidObjectId(token)) {
        category = await categoryRepository.findById(token);
      }
      if (!category) category = await categoryRepository.findByName(token);
      if (!category) {
        throw ApiError.badRequest(
          'food_categories contains an unknown category.',
          { food_categories: `"${token}" is not a known category` }
        );
      }
      ids.push(String(category._id));
      names.push(category.name);
    }
    return { ids: [...new Set(ids)], names: [...new Set(names)] };
  }

  #buildDocuments(files = {}, body = {}) {
    const documents = [];
    for (const file of files.documents || []) {
      documents.push({
        label: file.originalname || 'Verification document',
        // Private: only signed-in admins and the kitchen can open it.
        url: privateRef(file.filename),
        uploaded_at: new Date(),
      });
    }
    for (const doc of parseVerificationDocuments(body.verification_documents)) {
      documents.push({ label: doc.label, url: doc.url, uploaded_at: new Date() });
    }
    if (documents.length === 0) {
      throw ApiError.badRequest('At least one verification document is required.', {
        verification_documents: 'upload a document or provide a document URL',
      });
    }
    return documents;
  }
}

module.exports = new VendorAuthService();

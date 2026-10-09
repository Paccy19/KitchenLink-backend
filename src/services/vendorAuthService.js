const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone, parseDeliveryLocation } = require('../utils/validators');
const {
  parsePassword,
  parseRequiredText,
  parseVendorType,
  parseJsonField,
  parseOperatingHours,
  parsePaymentInformation,
  parseFoodCategoryTokens,
  parseVerificationDocuments,
} = require('../utils/vendorValidators');
const { serializeVendorAccount } = require('../utils/serializers');
const { hashPassword, comparePassword } = require('../utils/password');
const { buildPublicUrl, resolveImageUrl } = require('../utils/uploads');
const vendorRepository = require('../repositories/vendorRepository');
const categoryRepository = require('../repositories/categoryRepository');
const otpRepository = require('../repositories/otpRepository');

class VendorAuthService {
  /**
   * Registers a new vendor. Accounts start as `pending` verification and are
   * hidden from discovery (`is_active: false`) until an admin approves them.
   */
  async register(body = {}, files = {}) {
    const name = parseRequiredText(body.name, { field: 'name', min: 2, max: 120 });
    const ownerName = parseRequiredText(body.owner_name, {
      field: 'owner_name',
      min: 2,
      max: 120,
    });
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
    const paymentInformation = parsePaymentInformation(body.payment_information);
    const { ids: categoryIds, names: categoryNames } = await this.#resolveCategories(
      parseFoodCategoryTokens(body.food_categories)
    );
    const documents = this.#buildDocuments(files, body);

    const bannerImageUrl = resolveImageUrl({
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

    const vendor = await vendorRepository.create({
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
      is_active: true,
      delivery_available: true,
      available_balance: 0,
      total_sales: 0,
      ...(bannerImageUrl ? { banner_image_url: bannerImageUrl } : {}),
    });

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

    const code = String(crypto.randomInt(100000, 1000000));
    await otpRepository.create({
      phoneNumber: normalizedPhone,
      purpose: 'vendor',
      code,
      expiresAt: new Date(now + config.auth.otpTtlMinutes * 60 * 1000),
    });

    const isDev = config.env !== 'production';
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

  async changePassword(vendor, { current_password, new_password }) {
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
    return { updated: true };
  }

  #assertCanLogin(vendor) {
    if (vendor.verification_status === 'rejected') {
      throw ApiError.forbidden(
        'This vendor application was rejected. Contact support.',
        'VENDOR_REJECTED'
      );
    }
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
        url: buildPublicUrl(file.filename),
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

const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { normalizePhone, parseDeliveryLocation } = require('../utils/validators');
const {
  parseEmail,
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

const DUMMY_HASH =
  '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';

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
      is_active: false,
      delivery_available: false,
      available_balance: 0,
      total_sales: 0,
      ...(bannerImageUrl ? { banner_image_url: bannerImageUrl } : {}),
    });

    return { vendor: serializeVendorAccount(vendor), next: 'login' };
  }

  /**
   * Primary login: business/vendor name + phone number.
   * Email + password is still accepted for accounts created before.
   */
  async login({ name, phone, email, password }) {
    if (name && phone) return this.#loginByNamePhone(name, phone);
    if (email && password) return this.#loginWithPassword(email, password);
    throw ApiError.badRequest(
      'Provide business name and phone number, or email and password.',
      {
        name: 'required with phone',
        phone: 'required with name',
      }
    );
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

  async #loginByNamePhone(name, phone) {
    const vendorName = parseRequiredText(name, {
      field: 'name',
      min: 2,
      max: 120,
    });
    const normalizedPhone = normalizePhone(phone);

    const vendor = await vendorRepository.findByPhone(normalizedPhone);
    if (!vendor || vendor.name.toLowerCase() !== vendorName.toLowerCase()) {
      throw ApiError.unauthorized(
        'Invalid business name or phone number.',
        'INVALID_CREDENTIALS'
      );
    }

    this.#assertCanLogin(vendor);
    await vendorRepository.touchLogin(vendor._id);
    return this.#issueSession(vendor);
  }

  async #loginWithPassword(email, password) {
    const normalizedEmail = parseEmail(email);
    const rawPassword = parsePassword(password);

    const vendor = await vendorRepository.findByEmailWithPassword(normalizedEmail);
    const hash = vendor?.password_hash;

    // Compare against a dummy hash when the account is missing to keep timing flat.
    const ok = await comparePassword(rawPassword, hash || DUMMY_HASH);
    if (!vendor || !hash || !ok) {
      throw ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
    }

    this.#assertCanLogin(vendor);
    await vendorRepository.touchLogin(vendor._id);
    return this.#issueSession(vendor);
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

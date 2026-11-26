const config = require('../config');
const ApiError = require('../utils/ApiError');
const { revokeAllSessions } = require('../utils/sessions');
const { Vendor, KitchenStaff } = require('../models');
const kitchenAccess = require('./kitchen/accessService');
const kitchenActivity = require('./kitchen/activityService');
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
  parseVerificationDocuments,
} = require('../utils/vendorValidators');
const { serializeVendorAccount } = require('../utils/serializers');
const { hashPassword, comparePassword } = require('../utils/password');
const { privateRef, resolveImageUrl } = require('../utils/uploads');
const vendorRepository = require('../repositories/vendorRepository');
const vendorCategoryService = require('./vendorCategoryService');
const loginOtpService = require('./loginOtpService');
const otpGuardService = require('./otpGuardService');
const { identifierFrom } = require('../utils/identifier');
const notificationService = require('./notificationService');
const { assertVendorNotBlocked } = require('../utils/vendorAccess');

const serializeStaffSelf = (staff) => ({
  id: String(staff._id),
  name: staff.name,
  username: staff.username || null,
  phone: staff.phone || null,
  email: staff.email || null,
  job_title: staff.job_title || '',
  is_admin: Boolean(staff.is_admin),
});

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
    // Food categories come from the vendor type, never from the form: any
    // food_categories an older client still sends are ignored.
    const { food_category_ids: categoryIds, food_categories: categoryNames } = await vendorCategoryService.fieldsFor(vendorType);
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

  /**
   * Sign-in code to the kitchen's phone (SMS) or email address: the one
   * sign-in field takes either, and the server tells which. Only a kitchen
   * account is ever signed in here (the role comes from the account found).
   */
  async sendLoginOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    const { vendor } = await this.#findForLogin(identifier);
    this.#assertCanLogin(vendor);
    const sent = await loginOtpService.send({ identifier, purpose: 'vendor' });
    return {
      identifier: identifier.value,
      ...(identifier.type === 'phone' ? { phone_number: identifier.value } : { email: identifier.value }),
      ...sent,
    };
  }

  async verifyLoginOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    await loginOtpService.verify({ identifier, purpose: 'vendor', code: body.code });
    const { vendor, staff } = await this.#findForLogin(identifier, 'This vendor account is no longer available.');
    this.#assertCanLogin(vendor);
    if (staff) {
      await KitchenStaff.updateOne({ _id: staff._id }, { $set: { last_login_at: new Date() } });
      return this.#issueStaffSession(vendor, staff, 'code');
    }
    await vendorRepository.touchLogin(vendor._id);
    return this.#issueSession(vendor);
  }

  /**
   * The kitchen account with this phone / email, or else the kitchen of the
   * current, active employee with it (they sign in to that kitchen as staff).
   */
  async #findForLogin(identifier, missing = null) {
    const vendor = identifier.type === 'phone'
      ? await vendorRepository.findByPhone(identifier.value)
      : await vendorRepository.findByEmail(identifier.value);
    if (vendor && !vendor.deleted_at) return { vendor, staff: null };

    const staff = await this.findStaffByIdentifier(identifier);
    if (staff) {
      const employer = await vendorRepository.findById(staff.vendor_id);
      if (employer && !employer.deleted_at) return { vendor: employer, staff };
    }
    throw ApiError.notFound(
      missing || `No vendor account is registered with this ${identifier.type === 'phone' ? 'phone number' : 'email address'}.`,
      'VENDOR_NOT_FOUND'
    );
  }

  /**
   * POST /vendor/auth/staff-login — an employee signs in with the username
   * (or phone / email) and password their kitchen administrator gave them.
   * Wrong passwords count towards the same lockout as other sign-ins, and the
   * answer never says whether the username exists.
   */
  async staffPasswordLogin(body = {}) {
    const raw = typeof body.username === 'string' ? body.username : typeof body.identifier === 'string' ? body.identifier : '';
    const login = raw.trim().toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!login || !password) {
      throw ApiError.badRequest('Enter your username and password.', { username: login ? undefined : 'required', password: password ? undefined : 'required' });
    }
    const guardKey = `staff:${login}`;
    await otpGuardService.assertNotLocked(guardKey, 'staff-login');
    let phone = null;
    try {
      phone = /^[+\d\s()-]{9,16}$/.test(login) ? normalizePhone(login) : null;
    } catch {
      phone = null;
    }
    const staff = await KitchenStaff.findOne({
      is_current: true,
      deleted_at: null,
      $or: [{ username: login }, { email: login }, ...(phone ? [{ phone }] : [])],
    })
      .select('+password_hash')
      .lean();
    const ok = staff?.password_hash ? await comparePassword(password, staff.password_hash) : false;
    if (!ok) {
      if (staff) {
        require('./kitchen/alertService').emit(staff.vendor_id, 'employee_alerts', {
          title: `Wrong password for ${staff.name}`,
          body: 'Someone tried to sign in with a wrong password.',
          link: '/vendor-dashboard/activity',
          permission: 'audit.security_events',
        });
        kitchenActivity.recordSystem(staff.vendor_id, {
          action: 'security.login_failed',
          target_type: 'staff',
          target_id: staff._id,
          summary: `Wrong password for ${staff.name} (${login})`,
        });
      }
      await otpGuardService.recordFailedAttempt(guardKey, 'staff-login');
      throw ApiError.unauthorized('Wrong username or password.', 'INVALID_CREDENTIALS');
    }
    if (staff.is_active === false) {
      throw ApiError.forbidden('Your staff account has been deactivated. Ask your kitchen administrator.', 'STAFF_DEACTIVATED');
    }
    const vendor = await vendorRepository.findById(staff.vendor_id);
    if (!vendor || vendor.deleted_at) throw ApiError.unauthorized('Wrong username or password.', 'INVALID_CREDENTIALS');
    this.#assertCanLogin(vendor);
    await otpGuardService.clearFailures(guardKey, 'staff-login');
    const { password_hash: _hash, ...safe } = staff;
    await KitchenStaff.updateOne({ _id: staff._id }, { $set: { last_login_at: new Date() } });
    return this.#issueStaffSession(vendor, safe);
  }

  /** A current, active kitchen employee signing in with this phone / email. */
  async findStaffByIdentifier(identifier) {
    return KitchenStaff.findOne({
      [identifier.type === 'phone' ? 'phone' : 'email']: identifier.value,
      is_current: true,
      deleted_at: null,
      is_active: true,
    }).lean();
  }

  /**
   * The signed-in kitchen, and who is using it: the owner, or an employee
   * with their permissions (the dashboard shows only what they may use).
   * Employees who are not administrators don't see the payout details or the balance.
   */
  me(vendor, access = null) {
    const account = serializeVendorAccount(vendor);
    if (access && !access.isAdmin) {
      account.payment_information = {};
      account.available_balance_rwf = null;
      account.verification_documents = [];
    }
    return {
      vendor: account,
      access: access ? access.serialize() : null,
      staff: access?.staff ? serializeStaffSelf(access.staff) : null,
    };
  }

  async changePassword(vendor, { current_password, new_password, currentToken = null, staff = null }) {
    // An employee changes their own password (the one their administrator gave them).
    if (staff) {
      const newPassword = parsePassword(new_password, { field: 'new_password' });
      const fresh = await KitchenStaff.findById(staff._id).select('+password_hash').lean();
      if (fresh?.password_hash) {
        const ok = await comparePassword(typeof current_password === 'string' ? current_password : '', fresh.password_hash);
        if (!ok) throw ApiError.unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
      }
      await KitchenStaff.updateOne({ _id: staff._id }, { $set: { password_hash: await hashPassword(newPassword), password_set_at: new Date() } });
      await revokeAllSessions(KitchenStaff, staff._id, { keepPayload: currentToken });
      return { updated: true };
    }
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

  async #issueStaffSession(vendor, staff, method = 'password') {
    kitchenActivity.recordSystem(
      vendor._id,
      { action: 'security.login', target_type: 'staff', target_id: staff._id, summary: `${staff.name} signed in (${method === 'code' ? 'sign-in code' : 'username and password'})` },
      { type: 'staff', id: String(staff._id), name: staff.name }
    );
    const token = signToken({
      sub: String(vendor._id),
      role: config.vendor.jwtRole,
      staff_id: String(staff._id),
    });
    const access = await kitchenAccess.forStaff(vendor, staff);
    return {
      token,
      token_type: 'Bearer',
      expires_in: config.auth.jwtExpiresIn,
      ...this.me(vendor, access),
    };
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

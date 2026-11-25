const config = require('../config');
const ApiError = require('../utils/ApiError');
const { revokeAllSessions } = require('../utils/sessions');
const { Driver } = require('../models');
const { signToken } = require('../utils/jwt');
const { NAME_MAX_LENGTH, capitalizeName, normalizePhone } = require('../utils/validators');
const { parseEmail, parsePassword, parseRequiredText } = require('../utils/vendorValidators');
const { parseVehicleType } = require('../utils/deliveryValidators');
const { serializeDriverAccount } = require('../utils/serializers');
const { hashPassword, comparePassword } = require('../utils/password');
const driverRepository = require('../repositories/driverRepository');
const loginOtpService = require('./loginOtpService');
const { identifierFrom } = require('../utils/identifier');
const notificationService = require('./notificationService');

class DriverAuthService {
  /**
   * Registers a new driver. Accounts are immediately usable (approved) so the
   * OTP sign-in flow works right away, mirroring the vendor experience.
   */
  async register(body = {}) {
    const name = capitalizeName(parseRequiredText(body.name, { field: 'name', min: 2, max: NAME_MAX_LENGTH }));
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
        'A delivery worker with this phone number is already registered.',
        'PHONE_ALREADY_REGISTERED'
      );
    }
    if (email && (await driverRepository.findByEmail(email))) {
      throw ApiError.conflict(
        'A delivery worker with this email is already registered.',
        'EMAIL_ALREADY_REGISTERED'
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

    notificationService
      .notifyAdmin({
        type: 'driver_application',
        title: 'New delivery worker application',
        body: `${name} registered as a delivery worker and may need review.`,
        link: `/admin-dashboard/drivers?driver=${driver._id}`,
        data: { driver_id: String(driver._id), driver_name: name },
      })
      .catch(() => null);

    return { driver: serializeDriverAccount(driver), next: 'login' };
  }

  /**
   * Sign-in code to the delivery worker's phone (SMS) or email address: the
   * one sign-in field takes either, and the server tells which. Only a
   * delivery worker account is ever signed in here.
   */
  async sendLoginOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    const driver = await this.#findForLogin(identifier);
    this.#assertCanLogin(driver);
    const sent = await loginOtpService.send({ identifier, purpose: 'driver', name: driver.name });
    return {
      identifier: identifier.value,
      ...(identifier.type === 'phone' ? { phone_number: identifier.value } : { email: identifier.value }),
      ...sent,
    };
  }

  async verifyLoginOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    await loginOtpService.verify({ identifier, purpose: 'driver', code: body.code });
    const driver = await this.#findForLogin(identifier, 'This delivery worker account is no longer available.');
    this.#assertCanLogin(driver);
    await driverRepository.touchLogin(driver._id);
    return this.#issueSession(driver);
  }

  async #findForLogin(identifier, missing = null) {
    const driver = identifier.type === 'phone'
      ? await driverRepository.findByPhone(identifier.value)
      : await driverRepository.findByEmail(identifier.value);
    if (!driver || driver.deleted_at) {
      throw ApiError.notFound(
        missing || `No delivery worker account is registered with this ${identifier.type === 'phone' ? 'phone number' : 'email address'}.`,
        'DRIVER_NOT_FOUND'
      );
    }
    return driver;
  }

  me(driver) {
    return { driver: serializeDriverAccount(driver) };
  }

  async changePassword(driver, { current_password, new_password, currentToken = null }) {
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
    // Anyone else signed in with the old password is signed out.
    await revokeAllSessions(Driver, driver._id, { keepPayload: currentToken });
    return { updated: true };
  }

  #assertCanLogin(driver) {
    if (driver.verification_status === 'suspended') {
      throw ApiError.forbidden('This delivery worker account is suspended. Contact support.', 'DRIVER_SUSPENDED');
    }
    if (driver.verification_status === 'rejected') {
      throw ApiError.forbidden(
        'This delivery worker account was rejected. Contact support.',
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

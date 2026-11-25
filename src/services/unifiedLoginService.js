const ApiError = require('../utils/ApiError');
const { identifierFrom } = require('../utils/identifier');
const customerRepository = require('../repositories/customerRepository');
const vendorRepository = require('../repositories/vendorRepository');
const driverRepository = require('../repositories/driverRepository');
const authService = require('./authService');
const vendorAuthService = require('./vendorAuthService');
const driverAuthService = require('./driverAuthService');

const ROLE_ORDER = ['customer', 'vendor', 'driver'];

class UnifiedLoginService {
  async #accounts(identifier) {
    const lookup = (repository, phoneField) =>
      identifier.type === 'phone'
        ? repository.findByPhone(identifier.value)
        : repository.findByEmail(identifier.value);

    const [customer, vendor, driver] = await Promise.all([
      lookup(customerRepository, 'phone_number'),
      lookup(vendorRepository, 'phone'),
      lookup(driverRepository, 'phone'),
    ]);

    return [
      customer && { role: 'customer', account: customer },
      vendor && !vendor.deleted_at && { role: 'vendor', account: vendor },
      driver && !driver.deleted_at && { role: 'driver', account: driver },
    ].filter(Boolean);
  }

  async #resolve(identifier, requestedRole) {
    const accounts = await this.#accounts(identifier);
    if (accounts.length === 0) {
      throw ApiError.notFound(
        'No customer, vendor or delivery worker account was found for this phone number or email address.',
        'ACCOUNT_NOT_FOUND'
      );
    }

    const roles = ROLE_ORDER.filter((role) => accounts.some((account) => account.role === role));
    if (requestedRole) {
      if (!roles.includes(requestedRole)) {
        throw ApiError.notFound(
          'That account type is not associated with this phone number or email address.',
          'ACCOUNT_ROLE_NOT_FOUND'
        );
      }
      return { accounts, roles, role: requestedRole };
    }

    if (roles.length > 1) return { accounts, roles, role: null };
    return { accounts, roles, role: roles[0] };
  }

  async sendOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    const { accounts, roles, role } = await this.#resolve(identifier, body.role);
    if (!role) {
      return {
        requires_role_selection: true,
        roles,
        identifier: identifier.value,
        identifier_type: identifier.type,
      };
    }

    const account = accounts.find((candidate) => candidate.role === role).account;
    const result = role === 'customer'
      ? await authService.sendOtp({ identifier: identifier.value, name: account.name })
      : role === 'vendor'
        ? await vendorAuthService.sendLoginOtp({ identifier: identifier.value })
        : await driverAuthService.sendLoginOtp({ identifier: identifier.value });

    return { ...result, role, requires_role_selection: false };
  }

  async verifyOtp(body = {}) {
    const identifier = identifierFrom(body, 'phone', 'email');
    const role = String(body.role || '');
    if (!ROLE_ORDER.includes(role)) {
      throw ApiError.badRequest('Choose the account type you want to sign in to.', { role: 'required' });
    }

    const { accounts } = await this.#resolve(identifier, role);
    const account = accounts.find((candidate) => candidate.role === role).account;
    const result = role === 'customer'
      ? await authService.verifyOtp({ identifier: identifier.value, code: body.code, name: account.name })
      : role === 'vendor'
        ? await vendorAuthService.verifyLoginOtp({ identifier: identifier.value, code: body.code })
        : await driverAuthService.verifyLoginOtp({ identifier: identifier.value, code: body.code });

    return { ...result, role };
  }
}

module.exports = new UnifiedLoginService();

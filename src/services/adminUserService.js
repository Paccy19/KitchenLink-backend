const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const {
  serializeAdminCustomer,
  serializeAdminVendor,
  serializeAdminDriver,
} = require('../utils/serializers');
const customerRepository = require('../repositories/customerRepository');
const vendorRepository = require('../repositories/vendorRepository');
const driverRepository = require('../repositories/driverRepository');
const adminVendorService = require('./adminVendorService');
const adminDriverService = require('./adminDriverService');
const adminActionLogService = require('./adminActionLogService');

const ROLES = ['customer', 'vendor', 'driver'];
const CUSTOMER_STATUSES = ['active', 'suspended'];

const toCustomer = (customer) => ({
  id: String(customer._id),
  role: 'customer',
  name: customer.name,
  identifier: customer.phone_number,
  secondary: null,
  status: customer.is_active === false ? 'suspended' : 'active',
  is_active: customer.is_active !== false,
  avatar_url: customer.profile_image_url || null,
  last_login_at: customer.last_login_at ?? null,
  last_location: customer.last_location?.coordinates?.length === 2
    ? {
        latitude: customer.last_location.coordinates[1],
        longitude: customer.last_location.coordinates[0],
        accuracy_m: customer.last_location_accuracy_m ?? null,
        updated_at: customer.last_location_at ?? null,
      }
    : null,
  created_at: customer.created_at,
});

const toVendor = (vendor) => {
  const row = serializeAdminVendor(vendor);
  return {
    id: row.id,
    role: 'vendor',
    name: row.name,
    identifier: row.phone || row.email,
    secondary: row.vendor_type,
    status: row.status,
    is_active: row.is_active,
    avatar_url: row.profile_image_url,
    last_login_at: null,
    created_at: row.created_at,
  };
};

const toDriver = (driver) => {
  const row = serializeAdminDriver(driver);
  return {
    id: row.id,
    role: 'driver',
    name: row.name,
    identifier: row.phone || row.email,
    secondary: row.vehicle_type,
    status: row.verification_status,
    is_active: row.is_active,
    avatar_url: row.profile_image_url,
    last_login_at: null,
    created_at: row.created_at,
  };
};

class AdminUserService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const role = parseEnum(query.role, ROLES, 'role');
    const status = query.status ? String(query.status).trim() : undefined;
    const search = query.search ? String(query.search).trim() : undefined;
    const fetchLimit = offset + limit;

    const include = (target) => !role || role === target;
    const promises = [];
    let total = 0;

    const includeCustomers =
      include('customer') &&
      (!status || CUSTOMER_STATUSES.includes(status));

    if (includeCustomers) {
      const isActive =
        status === 'active' ? true : status === 'suspended' ? false : undefined;
      promises.push(
        customerRepository
          .adminList({ search, isActive, limit: fetchLimit, offset: 0 })
          .then(({ customers, total: t }) => {
            total += t;
            return customers.map(toCustomer);
          })
      );
    }

    const includeVendors = include('vendor') && (!status || ['pending', 'approved', 'rejected', 'suspended'].includes(status));
    if (includeVendors) {
      promises.push(
        vendorRepository
          .adminList({ search, status, limit: fetchLimit, offset: 0 })
          .then(({ vendors, total: t }) => {
            total += t;
            return vendors.map(toVendor);
          })
      );
    }

    const includeDrivers = include('driver') && (!status || ['pending', 'approved', 'rejected', 'suspended'].includes(status));
    if (includeDrivers) {
      promises.push(
        driverRepository
          .adminList({ search, status, limit: fetchLimit, offset: 0 })
          .then(({ drivers, total: t }) => {
            total += t;
            return drivers.map(toDriver);
          })
      );
    }

    const groups = await Promise.all(promises);
    const merged = groups
      .flat()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const items = merged.slice(offset, offset + limit);

    return { items, total, page, limit };
  }

  async getById(userId, query = {}) {
    parseObjectId(userId, 'user_id');
    const role = parseEnum(query.role, ROLES, 'role');

    if (role === 'vendor' || (!role && (await vendorRepository.findById(userId)))) {
      return adminVendorService.getById(userId);
    }

    if (role === 'driver') {
      const driver = await driverRepository.findById(userId);
      if (!driver) throw ApiError.notFound('Delivery worker not found.', 'DRIVER_NOT_FOUND');
      return { user: toDriver(driver) };
    }

    const customer = await customerRepository.findById(userId);
    if (!customer) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }
    return { user: toCustomer(customer) };
  }

  async setStatus(userId, { role, status, reason }, admin, req) {
    parseObjectId(userId, 'user_id');
    const targetRole = parseEnum(role, ROLES, 'role');
    if (!targetRole) {
      throw ApiError.badRequest('role is required.', {
        role: `expected one of: ${ROLES.join(', ')}`,
      });
    }

    if (targetRole === 'vendor') {
      return adminVendorService.setStatus(userId, { status, reason }, admin, req);
    }
    if (targetRole === 'driver') {
      return adminDriverService.setStatus(userId, { status, reason }, admin, req);
    }

    const nextStatus = parseEnum(status, CUSTOMER_STATUSES, 'status');
    if (!nextStatus) {
      throw ApiError.badRequest('status is required.', {
        status: `expected one of: ${CUSTOMER_STATUSES.join(', ')}`,
      });
    }
    const note = parseOptionalText(reason, { field: 'reason', max: 500 }) || '';

    const customer = await customerRepository.findById(userId);
    if (!customer) {
      throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
    }

    const updated = await customerRepository.update(userId, {
      is_active: nextStatus === 'active',
    });

    await adminActionLogService.record(
      admin,
      {
        action: `user.${nextStatus}`,
        target_type: 'customer',
        target_id: userId,
        target_label: customer.name,
        metadata: { reason: note },
      },
      req
    );

    return { user: toCustomer(updated) };
  }
}

module.exports = new AdminUserService();
module.exports.ROLES = ROLES;

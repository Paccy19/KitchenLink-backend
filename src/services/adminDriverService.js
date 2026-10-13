const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseBooleanQuery,
  parseEnum,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const {
  serializeAdminDriver,
  serializeDelivery,
} = require('../utils/serializers');
const driverRepository = require('../repositories/driverRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const adminActionLogService = require('./adminActionLogService');

const DRIVER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

class AdminDriverService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, DRIVER_STATUSES, 'status');
    const online =
      query.online === undefined
        ? undefined
        : parseBooleanQuery(query.online, { field: 'online' });

    const { drivers, total } = await driverRepository.adminList({
      status,
      online,
      search: query.search ? String(query.search).trim() : undefined,
      limit,
      offset,
    });
    return { items: drivers.map(serializeAdminDriver), total, page, limit };
  }

  async getById(driverId) {
    parseObjectId(driverId, 'driver_id');
    const driver = await driverRepository.findById(driverId);
    if (!driver) {
      throw ApiError.notFound('Delivery worker not found.', 'DRIVER_NOT_FOUND');
    }
    return { driver: serializeAdminDriver(driver) };
  }

  async setStatus(driverId, { status, reason }, admin, req) {
    parseObjectId(driverId, 'driver_id');
    const nextStatus = parseEnum(status, DRIVER_STATUSES, 'status');
    if (!nextStatus) {
      throw ApiError.badRequest('status is required.', {
        status: `expected one of: ${DRIVER_STATUSES.join(', ')}`,
      });
    }
    const note = parseOptionalText(reason, { field: 'reason', max: 500 }) || '';

    const driver = await driverRepository.findById(driverId);
    if (!driver) {
      throw ApiError.notFound('Delivery worker not found.', 'DRIVER_NOT_FOUND');
    }

    const update = { verification_status: nextStatus };
    let releasedDeliveries = 0;

    if (nextStatus === 'approved') {
      update.is_active = true;
      update.rejection_reason = '';
      update.suspension_reason = '';
      update.suspended_at = null;
    } else if (nextStatus === 'pending') {
      update.is_active = false;
    } else if (nextStatus === 'rejected') {
      update.is_active = false;
      update.rejection_reason = note;
    } else if (nextStatus === 'suspended') {
      update.is_active = false;
      update.suspension_reason = note;
      update.suspended_at = new Date();
      update.is_online = false;
      update.is_available = false;
      update.status = 'offline';
      releasedDeliveries = await this.#releaseDeliveries(driverId);
    }

    const updated = await driverRepository.update(driverId, update);

    await adminActionLogService.record(
      admin,
      {
        action: `driver.${nextStatus}`,
        target_type: 'driver',
        target_id: driverId,
        target_label: driver.name,
        metadata: { reason: note, released_deliveries: releasedDeliveries },
      },
      req
    );

    return {
      driver: serializeAdminDriver(updated),
      released_deliveries: releasedDeliveries,
    };
  }

  async liveDeliveries(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const liveStatuses = config.delivery.statuses.filter(
      (status) => !config.delivery.terminalStatuses.includes(status)
    );
    const { deliveries, total } = await deliveryRepository.adminList({
      statuses: liveStatuses,
      limit,
      offset,
    });
    return {
      items: deliveries.map((delivery) => serializeDelivery(delivery)),
      total,
      page,
      limit,
    };
  }

  async counts() {
    const [counts, online, active] = await Promise.all([
      driverRepository.countsByVerification(),
      driverRepository.countOnline(),
      driverRepository.countActive(),
    ]);
    return {
      pending: counts.pending || 0,
      approved: counts.approved || 0,
      rejected: counts.rejected || 0,
      suspended: counts.suspended || 0,
      online,
      active,
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    };
  }

  async #releaseDeliveries(driverId) {
    const deliveries = await deliveryRepository.findByDriver(
      driverId,
      config.delivery.activeStatuses
    );
    let released = 0;
    for (const delivery of deliveries) {
      await deliveryRepository.handback(delivery._id, {
        status: 'ready_for_pickup',
        note: 'Delivery worker suspended by admin — delivery released',
      });
      released += 1;
    }
    if (released > 0) {
      await driverRepository.update(driverId, { active_deliveries_count: 0 });
    }
    return released;
  }
}

module.exports = new AdminDriverService();
module.exports.DRIVER_STATUSES = DRIVER_STATUSES;

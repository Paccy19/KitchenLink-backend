const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const { serializeAdminVendor, serializeAdminOrder } = require('../utils/serializers');
const vendorRepository = require('../repositories/vendorRepository');
const orderRepository = require('../repositories/orderRepository');
const adminActionLogService = require('./adminActionLogService');
const settlementService = require('./settlementService');
const orderNotifications = require('./orderNotifications');

const VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

class AdminVendorService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, VENDOR_STATUSES, 'status');
    const { vendors, total } = await vendorRepository.adminList({
      status,
      search: query.search ? String(query.search).trim() : undefined,
      limit,
      offset,
    });
    return {
      items: vendors.map(serializeAdminVendor),
      total,
      page,
      limit,
    };
  }

  async getById(vendorId) {
    parseObjectId(vendorId, 'vendor_id');
    const vendor = await vendorRepository.findById(vendorId);
    if (!vendor) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }
    const { orders } = await orderRepository.adminList({
      vendorId,
      limit: 10,
      offset: 0,
    });
    const actions = await adminActionLogService.listForTarget('vendor', vendorId);
    return {
      vendor: serializeAdminVendor(vendor),
      recent_orders: orders.map(serializeAdminOrder),
      actions,
    };
  }

  async setStatus(vendorId, { status, reason }, admin, req) {
    parseObjectId(vendorId, 'vendor_id');
    const nextStatus = parseEnum(status, VENDOR_STATUSES, 'status');
    if (!nextStatus) {
      throw ApiError.badRequest('status is required.', {
        status: `expected one of: ${VENDOR_STATUSES.join(', ')}`,
      });
    }
    const note = parseOptionalText(reason, { field: 'reason', max: 500 }) || '';

    const vendor = await vendorRepository.findById(vendorId);
    if (!vendor) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }

    const update = { verification_status: nextStatus };
    let cancelledOrders = 0;

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
      const openOrders = await orderRepository.listOpenByVendor(
        vendorId,
        config.vendor.pendingInternalStatuses
      );
      cancelledOrders = await orderRepository.cancelOpenByVendor(
        vendorId,
        config.vendor.pendingInternalStatuses,
        note || 'Vendor suspended by admin'
      );
      // Refund customers who had paid for the cancelled orders.
      for (const order of openOrders) {
        await settlementService.refundOrder(order);
      }
    }

    const updated = await vendorRepository.update(vendorId, update);
    if (nextStatus !== vendor.verification_status) orderNotifications.vendorAccount(vendorId, nextStatus, note);

    await adminActionLogService.record(
      admin,
      {
        action: `vendor.${nextStatus}`,
        target_type: 'vendor',
        target_id: vendorId,
        target_label: vendor.name,
        metadata: { reason: note, cancelled_orders: cancelledOrders },
      },
      req
    );

    return {
      vendor: serializeAdminVendor(updated),
      cancelled_orders: cancelledOrders,
    };
  }

  async counts() {
    const counts = await vendorRepository.countsByVerification();
    return {
      pending: counts.pending || 0,
      approved: counts.approved || 0,
      rejected: counts.rejected || 0,
      suspended: counts.suspended || 0,
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    };
  }
}

module.exports = new AdminVendorService();
module.exports.VENDOR_STATUSES = VENDOR_STATUSES;

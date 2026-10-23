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
const notificationService = require('./notificationService');
const {
  VENDOR_TYPES,
  parseVendorType,
  parseVendorTypeFilter,
  vendorTypeLabel,
} = require('../config/vendorTypes');

/** Every type with how many vendors have it (zero included), for grouping. */
const typeBreakdown = (counts) =>
  VENDOR_TYPES.map((type) => ({ code: type.code, label: type.label, count: counts[type.code] || 0 }));

const VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

class AdminVendorService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, VENDOR_STATUSES, 'status');
    const vendorTypes = parseVendorTypeFilter(query);
    const [{ vendors, total }, typeCounts] = await Promise.all([
      vendorRepository.adminList({
        status,
        search: query.search ? String(query.search).trim() : undefined,
        vendorTypes,
        limit,
        offset,
      }),
      // Counts per type within the chosen status, for the type filter/grouping.
      vendorRepository.countsByType({ status }),
    ]);
    return {
      items: vendors.map(serializeAdminVendor),
      total,
      page,
      limit,
      vendor_types: vendorTypes,
      type_counts: typeBreakdown(typeCounts),
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

    const hasDocuments = (vendor.verification_documents || []).length > 0;
    const wasApproved = vendor.verification_status === 'approved';
    // Only a transition *into* approved needs a review; re-saving an already
    // approved vendor (e.g. legacy accounts approved before reviews existed) is allowed.
    if (nextStatus === 'approved' && !wasApproved && hasDocuments && !vendor.documents_reviewed_at) {
      throw new ApiError(
        400,
        'DOCUMENTS_NOT_REVIEWED',
        'Open and review this vendor\'s verification documents before approving.',
        { verification_documents: 'mark the documents as reviewed first' }
      );
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
        await settlementService.refundOrder(order, { by: 'admin', reason: note || 'Kitchen suspended' });
      }
    }

    // Leaving the approved state invalidates the previous document review, so
    // re-approval always requires a fresh look at the documents.
    if (wasApproved && nextStatus !== 'approved') {
      update.documents_reviewed_at = null;
      update.documents_reviewed_by = null;
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

  async reviewDocuments(vendorId, admin, req) {
    parseObjectId(vendorId, 'vendor_id');
    const vendor = await vendorRepository.findById(vendorId);
    if (!vendor) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }
    if ((vendor.verification_documents || []).length === 0) {
      throw new ApiError(400, 'NO_DOCUMENTS', 'This vendor has no verification documents to review.');
    }

    const updated = await vendorRepository.update(vendorId, {
      documents_reviewed_at: new Date(),
      documents_reviewed_by: admin?._id ?? null,
    });

    await adminActionLogService.record(
      admin,
      {
        action: 'vendor.documents_reviewed',
        target_type: 'vendor',
        target_id: vendorId,
        target_label: vendor.name,
        metadata: { documents: (vendor.verification_documents || []).length },
      },
      req
    );

    return { vendor: serializeAdminVendor(updated) };
  }

  /**
   * An admin sets a vendor's type directly, or answers their change request
   * (`decision`: 'approve' uses the requested type, 'reject' keeps the current one).
   */
  async setType(vendorId, body = {}, admin, req) {
    parseObjectId(vendorId, 'vendor_id');
    const vendor = await vendorRepository.findById(vendorId);
    if (!vendor) throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');

    const requested = vendor.vendor_type_request?.vendor_type || null;
    const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null;
    if (decision && !requested) {
      throw ApiError.conflict('This vendor has no pending type change request.', 'NO_TYPE_REQUEST');
    }
    const note = parseOptionalText(body.reason, { field: 'reason', max: 300 }) || '';
    const nextType =
      decision === 'reject' ? vendor.vendor_type : decision === 'approve' ? requested : parseVendorType(body.vendor_type);

    const updated = await vendorRepository.update(vendorId, {
      vendor_type: nextType,
      vendor_type_request: { vendor_type: null, reason: '', requested_at: null },
    });

    const extra = note ? ` ${note}` : '';
    if (nextType !== vendor.vendor_type || decision) {
      notificationService
        .notifyVendor(vendorId, {
          type: 'account_update',
          title: decision === 'reject' ? 'Vendor type change declined' : 'Vendor type updated',
          body:
            decision === 'reject'
              ? `Your request to become ${vendorTypeLabel(requested)} was declined. You stay listed as ${vendorTypeLabel(vendor.vendor_type)}.${extra}`
              : `Your kitchen is now listed as ${vendorTypeLabel(nextType)}.${extra}`,
          link: '/vendor-dashboard/profile',
          data: { vendor_type: nextType },
        })
        .catch(() => null);
    }

    await adminActionLogService.record(
      admin,
      {
        action: decision ? `vendor.type_request_${decision === 'approve' ? 'approved' : 'rejected'}` : 'vendor.type_changed',
        target_type: 'vendor',
        target_id: vendorId,
        target_label: vendor.name,
        metadata: { from: vendor.vendor_type, to: nextType, requested, reason: note },
      },
      req
    );

    return { vendor: serializeAdminVendor(updated) };
  }

  async counts() {
    const [counts, typeCounts] = await Promise.all([
      vendorRepository.countsByVerification(),
      vendorRepository.countsByType(),
    ]);
    return {
      by_type: typeBreakdown(typeCounts),
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

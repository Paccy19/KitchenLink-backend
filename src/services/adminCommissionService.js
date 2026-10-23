const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseOptionalText,
  parsePercentage,
  parseNonNegativeInt,
  parseObjectId,
  parseBooleanQuery,
} = require('../utils/adminValidators');
const { serializeAdminCommission } = require('../utils/serializers');
const commissionRepository = require('../repositories/commissionRepository');
const adminActionLogService = require('./adminActionLogService');
const { VENDOR_TYPE_CODES, toVendorTypeCode } = require('../config/vendorTypes');

const SCOPES = ['global', 'vendor', 'category', 'vendor_type'];

class AdminCommissionService {
  async list(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const scope = parseEnum(query.scope, SCOPES, 'scope');
    const isActive =
      query.is_active === undefined
        ? undefined
        : parseBooleanQuery(query.is_active, { field: 'is_active' });

    const { commissions, total } = await commissionRepository.list({
      scope,
      isActive,
      limit,
      offset,
    });
    return { items: commissions.map(serializeAdminCommission), total, page, limit };
  }

  async create(body = {}, admin, req) {
    const payload = this.#parsePayload(body, { requireName: true });
    const commission = await commissionRepository.create(payload);

    await adminActionLogService.record(
      admin,
      {
        action: 'commission.create',
        target_type: 'commission',
        target_id: commission._id,
        target_label: commission.name,
        metadata: { scope: commission.scope, percentage: commission.percentage },
      },
      req
    );

    return { commission: serializeAdminCommission(commission) };
  }

  async update(commissionId, body = {}, admin, req) {
    parseObjectId(commissionId, 'commission_id');
    const existing = await commissionRepository.findById(commissionId);
    if (!existing) {
      throw ApiError.notFound('Commission config not found.', 'COMMISSION_NOT_FOUND');
    }

    const payload = this.#parsePayload(body, { partial: true });
    if (Object.keys(payload).length === 0) {
      throw ApiError.badRequest('No changes provided.', {
        commission: 'provide at least one field to update',
      });
    }

    const updated = await commissionRepository.update(commissionId, payload);

    await adminActionLogService.record(
      admin,
      {
        action: 'commission.update',
        target_type: 'commission',
        target_id: commissionId,
        target_label: updated.name,
        metadata: payload,
      },
      req
    );

    return { commission: serializeAdminCommission(updated) };
  }

  async remove(commissionId, admin, req) {
    parseObjectId(commissionId, 'commission_id');
    const existing = await commissionRepository.findById(commissionId);
    if (!existing) {
      throw ApiError.notFound('Commission config not found.', 'COMMISSION_NOT_FOUND');
    }

    await commissionRepository.softDelete(commissionId);
    await adminActionLogService.record(
      admin,
      {
        action: 'commission.delete',
        target_type: 'commission',
        target_id: commissionId,
        target_label: existing.name,
      },
      req
    );
    return { deleted: true };
  }

  #parsePayload(body, { partial = false, requireName = false } = {}) {
    const payload = {};

    if (body.name !== undefined) {
      const name = parseOptionalText(body.name, { field: 'name', max: 120 });
      if (!name) {
        throw ApiError.badRequest('name cannot be empty.', { name: 'expected a name' });
      }
      payload.name = name;
    } else if (requireName) {
      throw ApiError.badRequest('name is required.', {
        name: 'expected a descriptive name',
      });
    }

    if (body.scope !== undefined) {
      const scope = parseEnum(body.scope, SCOPES, 'scope');
      if (scope) payload.scope = scope;
    }

    if (body.vendor_id !== undefined) {
      payload.vendor_id = body.vendor_id
        ? parseObjectId(body.vendor_id, 'vendor_id')
        : null;
    }
    if (body.category_id !== undefined) {
      payload.category_id = body.category_id
        ? parseObjectId(body.category_id, 'category_id')
        : null;
    }
    if (body.vendor_type !== undefined) {
      const vendorType = parseOptionalText(body.vendor_type, {
        field: 'vendor_type',
        max: 60,
      });
      const code = vendorType ? toVendorTypeCode(vendorType) : '';
      if (vendorType && !code) {
        throw ApiError.badRequest('vendor_type is invalid.', {
          vendor_type: `expected one of: ${VENDOR_TYPE_CODES.join(', ')}`,
        });
      }
      payload.vendor_type = code || '';
    }

    if (body.percentage !== undefined) {
      payload.percentage = parsePercentage(body.percentage, 'percentage');
    }
    if (body.fixed_fee_rwf !== undefined) {
      payload.fixed_fee_rwf = parseNonNegativeInt(body.fixed_fee_rwf, 'fixed_fee_rwf');
    }
    if (body.is_active !== undefined) {
      payload.is_active = parseBooleanQuery(body.is_active, { field: 'is_active' });
    }

    const scope = payload.scope;
    if (scope === 'vendor' && !partial && !payload.vendor_id) {
      throw ApiError.badRequest('vendor_id is required for vendor scope.', {
        vendor_id: 'expected a vendor id',
      });
    }
    if (scope === 'category' && !partial && !payload.category_id) {
      throw ApiError.badRequest('category_id is required for category scope.', {
        category_id: 'expected a category id',
      });
    }
    if (scope === 'vendor_type' && !partial && !payload.vendor_type) {
      throw ApiError.badRequest('vendor_type is required for vendor_type scope.', {
        vendor_type: 'expected a vendor type',
      });
    }

    return payload;
  }
}

module.exports = new AdminCommissionService();
module.exports.SCOPES = SCOPES;

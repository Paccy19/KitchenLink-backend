const config = require('../config');
const ApiError = require('../utils/ApiError');
const {
  parseAdminListQuery,
  parseEnum,
  parseDateRange,
  parseOptionalText,
  parseObjectId,
} = require('../utils/adminValidators');
const { serializeAdminWithdrawal } = require('../utils/serializers');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const vendorRepository = require('../repositories/vendorRepository');
const adminActionLogService = require('./adminActionLogService');

const WITHDRAWAL_STATUSES = ['processing', 'completed', 'failed'];
const FINALIZED = ['completed', 'failed'];

class AdminPayoutService {
  async listWithdrawals(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, WITHDRAWAL_STATUSES, 'status');
    const { withdrawals, total } = await withdrawalRepository.adminList({
      status,
      vendorId: query.vendor_id,
      limit,
      offset,
    });
    return { items: withdrawals.map(serializeAdminWithdrawal), total, page, limit };
  }

  async updateWithdrawal(withdrawalId, { status, reference }, admin, req) {
    parseObjectId(withdrawalId, 'withdrawal_id');
    const nextStatus = parseEnum(status, WITHDRAWAL_STATUSES, 'status');
    if (!nextStatus) {
      throw ApiError.badRequest('status is required.', {
        status: `expected one of: ${WITHDRAWAL_STATUSES.join(', ')}`,
      });
    }

    const withdrawal = await withdrawalRepository.findById(withdrawalId);
    if (!withdrawal) {
      throw ApiError.notFound('Payout request not found.', 'WITHDRAWAL_NOT_FOUND');
    }

    const update = { status: nextStatus };
    if (reference !== undefined) {
      update.reference = parseOptionalText(reference, { field: 'reference', max: 120 }) || '';
    }
    if (FINALIZED.includes(nextStatus)) {
      update.processed_at = new Date();
    }

    const updated = await withdrawalRepository.updateStatus(withdrawalId, update);

    await adminActionLogService.record(
      admin,
      {
        action: `payout.${nextStatus}`,
        target_type: 'withdrawal',
        target_id: withdrawalId,
        target_label: String(withdrawal.amount_rwf),
        metadata: { status: nextStatus, reference: update.reference },
      },
      req
    );

    return { withdrawal: serializeAdminWithdrawal(updated) };
  }

  async vendorBalances(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const { vendors, total } = await vendorRepository.listBalances({
      sort: query.sort,
      limit,
      offset,
    });
    const commissionPercent = config.admin.commissionDefaultPercent;
    return {
      items: vendors.map((vendor) => ({
        id: String(vendor._id),
        name: vendor.name,
        neighborhood: vendor.neighborhood || null,
        available_balance_rwf: vendor.available_balance ?? 0,
        total_sales_rwf: vendor.total_sales ?? 0,
        estimated_commission_rwf: Math.round(
          (vendor.total_sales ?? 0) * (commissionPercent / 100)
        ),
      })),
      total,
      page,
      limit,
      commission_percent: commissionPercent,
    };
  }

  async summary(query = {}) {
    const { from, to } = parseDateRange(query);
    const rows = await withdrawalRepository.totalsByStatus();
    return {
      range: { from: from ?? null, to: to ?? null },
      by_status: rows.map((row) => ({
        status: row._id,
        total_rwf: row.total,
        count: row.count,
      })),
      payout_fee_rwf: config.admin.payoutFeeRwf,
    };
  }
}

module.exports = new AdminPayoutService();
module.exports.WITHDRAWAL_STATUSES = WITHDRAWAL_STATUSES;

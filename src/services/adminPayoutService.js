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
const driverRepository = require('../repositories/driverRepository');
const transactionRepository = require('../repositories/transactionRepository');
const adminActionLogService = require('./adminActionLogService');
const notificationService = require('./notificationService');
const orderNotifications = require('./orderNotifications');

const WITHDRAWAL_STATUSES = ['processing', 'completed', 'failed'];
const PAYEE_TYPES = ['vendor', 'driver'];

class AdminPayoutService {
  async listWithdrawals(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const status = parseEnum(query.status, WITHDRAWAL_STATUSES, 'status');
    const payeeType = parseEnum(query.payee_type, PAYEE_TYPES, 'payee_type');
    const { withdrawals, total } = await withdrawalRepository.adminList({
      status,
      payeeType,
      vendorId: query.vendor_id,
      driverId: query.driver_id,
      limit,
      offset,
    });
    return { items: withdrawals.map(serializeAdminWithdrawal), total, page, limit };
  }

  /**
   * Admin decision on a payout request (vendor or rider). Only `processing`
   * requests can be decided, exactly once:
   *  - completed: the admin has sent the money (reference = MoMo/bank txn id);
   *    recorded on the ledger and the rider is notified.
   *  - failed: the reserved amount is returned to the payee's balance.
   * A finalized request only accepts reference corrections.
   */
  async updateWithdrawal(withdrawalId, { status, reference, reason }, admin, req) {
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

    const cleanReference =
      reference !== undefined
        ? parseOptionalText(reference, { field: 'reference', max: 120 }) || ''
        : undefined;

    // Same status: only allow correcting the reference.
    if (nextStatus === withdrawal.status) {
      if (cleanReference !== undefined) {
        await withdrawalRepository.updateStatus(withdrawalId, { reference: cleanReference });
      }
      return {
        withdrawal: serializeAdminWithdrawal(
          await withdrawalRepository.findByIdPopulated(withdrawalId)
        ),
      };
    }

    if (withdrawal.status !== 'processing') {
      throw ApiError.conflict(
        `This payout is already ${withdrawal.status} and cannot be changed.`,
        'WITHDRAWAL_FINALIZED'
      );
    }
    if (nextStatus === 'completed' && !cleanReference) {
      throw ApiError.badRequest('Enter the transaction reference of the payment you sent.', {
        reference: 'required when marking a payout completed (e.g. the MoMo transaction id)',
      });
    }
    const failureReason =
      nextStatus === 'failed'
        ? parseOptionalText(reason, { field: 'reason', max: 200 }) || ''
        : '';

    const finalized = await withdrawalRepository.finalizeProcessing(withdrawalId, {
      status: nextStatus,
      processed_at: new Date(),
      ...(cleanReference !== undefined ? { reference: cleanReference } : {}),
      ...(failureReason ? { failure_reason: failureReason } : {}),
    });
    if (!finalized) {
      throw ApiError.conflict('This payout was just updated by someone else.', 'WITHDRAWAL_FINALIZED');
    }

    const isDriver = withdrawal.payee_type === 'driver';
    const payeeId = isDriver ? withdrawal.driver_id : withdrawal.vendor_id;

    if (nextStatus === 'failed') {
      // Return the reserved amount so the payee can withdraw it again.
      if (isDriver) await driverRepository.incrementBalance(payeeId, withdrawal.amount_rwf);
      else await vendorRepository.incrementBalance(payeeId, withdrawal.amount_rwf);
    } else {
      await transactionRepository.create({
        type: 'withdrawal',
        direction: 'debit',
        status: 'settled',
        amount_rwf: withdrawal.amount_rwf,
        ...(isDriver ? { driver_id: payeeId } : { vendor_id: payeeId }),
        reference: cleanReference,
        description: `${isDriver ? 'Delivery worker' : 'Vendor'} withdrawal paid via ${
          withdrawal.method_label || withdrawal.method
        }${withdrawal.account_number ? ` to ${withdrawal.account_number}` : ''}`,
        metadata: { withdrawal_id: String(withdrawal._id), payee_type: withdrawal.payee_type || 'vendor' },
      });
    }

    if (!isDriver) {
      orderNotifications.vendorPayout(withdrawal, { status: nextStatus, reference: cleanReference, reason: failureReason });
    }
    if (isDriver) {
      notificationService
        .notifyDriverPayout(payeeId, {
          status: nextStatus,
          amountRwf: withdrawal.amount_rwf,
          accountNumber: withdrawal.account_number,
          reference: cleanReference,
          reason: failureReason,
        })
        .catch(() => null);
    }

    await adminActionLogService.record(
      admin,
      {
        action: `payout.${nextStatus}`,
        target_type: 'withdrawal',
        target_id: withdrawalId,
        target_label: String(withdrawal.amount_rwf),
        metadata: {
          status: nextStatus,
          payee_type: withdrawal.payee_type || 'vendor',
          reference: cleanReference,
          reason: failureReason || undefined,
        },
      },
      req
    );

    return {
      withdrawal: serializeAdminWithdrawal(
        await withdrawalRepository.findByIdPopulated(withdrawalId)
      ),
    };
  }

  async vendorBalances(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    if (query.payee_type === 'driver') {
      const { drivers, total } = await driverRepository.listBalances({ limit, offset });
      return {
        payee_type: 'driver',
        items: drivers.map((driver) => ({
          id: String(driver._id),
          name: driver.name,
          phone: driver.phone || null,
          vehicle_type: driver.vehicle_type || null,
          available_balance_rwf: driver.available_balance_rwf ?? 0,
          total_earnings_rwf: driver.total_earnings_rwf ?? 0,
          completed_deliveries: driver.completed_deliveries ?? 0,
        })),
        total,
        page,
        limit,
      };
    }
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
    const payeeType = parseEnum(query.payee_type, PAYEE_TYPES, 'payee_type');
    const rows = await withdrawalRepository.totalsByStatus({ payeeType });
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

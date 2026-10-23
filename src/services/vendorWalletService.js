const config = require('../config');
const ApiError = require('../utils/ApiError');
const { serializeWithdrawal } = require('../utils/serializers');
const vendorRepository = require('../repositories/vendorRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const orderRepository = require('../repositories/orderRepository');
const notificationService = require('./notificationService');
const commissionService = require('./commissionService');
const {
  normalizeMethod,
  parseAmount,
  parsePayoutDestination,
  parsePayoutPhone,
  generateReference,
} = require('../utils/withdrawals');

/** The registered phone in the local 07… form the payout goes to (null if not a MoMo number). */
const registeredPayoutPhone = (phone) => {
  if (!phone) return null;
  try {
    return parsePayoutPhone(phone);
  } catch {
    return null;
  }
};

class VendorWalletService {
  async getWallet(vendor) {
    const [withdrawnRwf, activeSalesRwf, withdrawals] = await Promise.all([
      withdrawalRepository.totalWithdrawn(vendor._id),
      orderRepository.activeSalesTotal(
        vendor._id,
        config.vendor.pendingInternalStatuses
      ),
      withdrawalRepository.listByVendor(vendor._id),
    ]);

    const commissionPercent = await commissionService.globalPercent();
    const commissionRate = commissionPercent / 100;

    return {
      available_balance_rwf: vendor.available_balance ?? 0,
      total_sales_rwf: vendor.total_sales ?? 0,
      withdrawn_rwf: withdrawnRwf,
      pending_balance_rwf: Math.round(activeSalesRwf * (1 - commissionRate)),
      commission_percent: commissionPercent,
      // Suggested payout number: the phone the kitchen registered with.
      payout_phone: registeredPayoutPhone(vendor.phone),
      payout_name: vendor.owner_name || vendor.name || '',
      withdrawals: withdrawals.map(serializeWithdrawal),
    };
  }

  async requestWithdrawal(vendor, body = {}) {
    const amount = parseAmount(body.amount_rwf);
    const method = normalizeMethod(body.method);
    // Mobile money goes to the number they registered with unless they gave another.
    const destination = parsePayoutDestination(method, body, {
      defaultPhone: vendor.phone,
      defaultName: vendor.owner_name || vendor.name || '',
    });

    const updated = await vendorRepository.decrementBalance(vendor._id, amount);
    if (!updated) {
      throw ApiError.badRequest('Insufficient available balance.', {
        amount_rwf: `available balance is ${vendor.available_balance ?? 0} RWF`,
      });
    }

    const withdrawal = await withdrawalRepository.create({
      payee_type: 'vendor',
      vendor_id: vendor._id,
      amount_rwf: amount,
      method: method.code,
      ...destination,
      status: 'processing',
      reference: generateReference('WD'),
    });

    const where =
      method.code === 'bank_transfer'
        ? `${destination.bank_name} account ${destination.account_number}`
        : `${destination.method_label} ${destination.account_number}`;
    notificationService
      .notifyAdmin({
        type: 'payout_requested',
        title: 'Payout requested',
        body: `${vendor.name || 'A vendor'} requested a payout of ${amount.toLocaleString()} RWF to ${where}.`,
        link: `/admin-dashboard/payouts?payout=${withdrawal._id}`,
        data: {
          withdrawal_id: String(withdrawal._id),
          amount_rwf: amount,
          vendor_id: String(vendor._id),
        },
      })
      .catch(() => null);

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      available_balance_rwf: updated.available_balance,
    };
  }
}

module.exports = new VendorWalletService();

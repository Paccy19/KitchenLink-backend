const config = require('../config');
const ApiError = require('../utils/ApiError');
const { serializeWithdrawal } = require('../utils/serializers');
const vendorRepository = require('../repositories/vendorRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const orderRepository = require('../repositories/orderRepository');

const METHOD_ALIASES = [
  { match: /momo|mtn|mobile|airtel/i, code: 'mobile_money' },
  { match: /bank|transfer/i, code: 'bank_transfer' },
  { match: /cash/i, code: 'cash' },
];

const normalizeMethod = (raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return { code: 'mobile_money', label: 'MTN Mobile Money' };
  const alias = METHOD_ALIASES.find((entry) => entry.match.test(value));
  const code = alias?.code ?? 'other';
  const label = value.length <= 40 ? value : value.slice(0, 40);
  return { code, label };
};

const parseAmount = (raw) => {
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.badRequest('amount_rwf must be a positive whole number.', {
      amount_rwf: 'expected an integer greater than 0',
    });
  }
  return amount;
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

    const commissionRate = config.vendor.commissionPercent / 100;

    return {
      available_balance_rwf: vendor.available_balance ?? 0,
      total_sales_rwf: vendor.total_sales ?? 0,
      withdrawn_rwf: withdrawnRwf,
      pending_balance_rwf: Math.round(activeSalesRwf * (1 - commissionRate)),
      commission_percent: config.vendor.commissionPercent,
      withdrawals: withdrawals.map(serializeWithdrawal),
    };
  }

  async requestWithdrawal(vendor, body = {}) {
    const amount = parseAmount(body.amount_rwf);
    const { code, label } = normalizeMethod(body.method);

    const updated = await vendorRepository.decrementBalance(vendor._id, amount);
    if (!updated) {
      throw ApiError.badRequest('Insufficient available balance.', {
        amount_rwf: `available balance is ${vendor.available_balance ?? 0} RWF`,
      });
    }

    const withdrawal = await withdrawalRepository.create({
      vendor_id: vendor._id,
      amount_rwf: amount,
      method: code,
      method_label: label,
      status: 'processing',
      reference: `WD-${new Date().getFullYear()}-${String(
        Math.floor(1000 + Math.random() * 9000)
      )}`,
    });

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      available_balance_rwf: updated.available_balance,
    };
  }
}

module.exports = new VendorWalletService();

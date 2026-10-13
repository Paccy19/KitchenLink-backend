const ApiError = require('../utils/ApiError');
const { serializeWithdrawal } = require('../utils/serializers');
const {
  normalizeMethod,
  parseAmount,
  parsePayoutPhone,
  generateReference,
} = require('../utils/withdrawals');
const driverRepository = require('../repositories/driverRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const notificationService = require('./notificationService');

/**
 * Rider wallet. Every completed delivery credits the full delivery fee to the
 * rider's available balance; the rider withdraws it to mobile money and an
 * admin pays it out (mirrors the vendor wallet).
 */
class DriverWalletService {
  #defaultPayoutPhone(driver) {
    if (!driver.phone) return null;
    try {
      return parsePayoutPhone(driver.phone);
    } catch {
      return driver.phone;
    }
  }

  async getWallet(driver) {
    const [withdrawnRwf, processingRwf, withdrawals] = await Promise.all([
      withdrawalRepository.totalWithdrawnByDriver(driver._id),
      withdrawalRepository.totalProcessingByDriver(driver._id),
      withdrawalRepository.listByDriver(driver._id),
    ]);

    return {
      available_balance_rwf: driver.available_balance_rwf ?? 0,
      total_earnings_rwf: driver.total_earnings_rwf ?? 0,
      withdrawn_rwf: withdrawnRwf,
      processing_rwf: processingRwf,
      // Default payout number, in the same local form the payout is sent to.
      payout_phone: this.#defaultPayoutPhone(driver),
      withdrawals: withdrawals.map(serializeWithdrawal),
    };
  }

  async requestWithdrawal(driver, body = {}) {
    const amount = parseAmount(body.amount_rwf);
    const { code, label } = normalizeMethod(body.method);
    // Riders are paid by mobile money; default to their login number.
    const accountNumber = parsePayoutPhone(body.phone ?? driver.phone, 'phone');
    if (code !== 'mobile_money') {
      throw ApiError.badRequest('Delivery workers are paid by mobile money (MTN or Airtel).', {
        method: 'expected MTN Mobile Money or Airtel Money',
      });
    }

    const updated = await driverRepository.decrementBalance(driver._id, amount);
    if (!updated) {
      throw ApiError.badRequest('Insufficient available balance.', {
        amount_rwf: `available balance is ${driver.available_balance_rwf ?? 0} RWF`,
      });
    }

    const withdrawal = await withdrawalRepository.create({
      payee_type: 'driver',
      driver_id: driver._id,
      amount_rwf: amount,
      method: code,
      method_label: label,
      account_number: accountNumber,
      account_name: driver.name || '',
      status: 'processing',
      reference: generateReference('RWD'),
    });

    notificationService
      .notifyAdmin({
        type: 'payout_requested',
        title: 'Delivery worker payout requested',
        body: `${driver.name || 'A delivery worker'} requested a payout of ${amount.toLocaleString()} RWF to ${label} ${accountNumber}.`,
        link: `/admin-dashboard/payouts?payout=${withdrawal._id}`,
        data: {
          withdrawal_id: String(withdrawal._id),
          amount_rwf: amount,
          payee_type: 'driver',
          driver_id: String(driver._id),
        },
      })
      .catch(() => null);

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      available_balance_rwf: updated.available_balance_rwf,
    };
  }
}

module.exports = new DriverWalletService();

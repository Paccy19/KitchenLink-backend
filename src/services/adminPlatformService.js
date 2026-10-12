const config = require('../config');
const parsePagination = require('../utils/pagination');
const { parseEnum } = require('../utils/adminValidators');
const {
  serializePlatformAccount,
  serializeTransaction,
} = require('../utils/serializers');
const platformAccountRepository = require('../repositories/platformAccountRepository');
const transactionRepository = require('../repositories/transactionRepository');

const TRANSACTION_TYPES = [
  'order_payment',
  'vendor_payout',
  'driver_payout',
  'commission',
  'refund',
];

class AdminPlatformService {
  /** Platform (system admin) money account + recent ledger activity. */
  async wallet(query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const type = parseEnum(query.type, TRANSACTION_TYPES, 'type');

    const [account, { transactions, total }] = await Promise.all([
      platformAccountRepository.getOrCreate(),
      transactionRepository.list({ type, limit, offset }),
    ]);

    return {
      account: serializePlatformAccount(account),
      transactions: transactions.map(serializeTransaction),
      total,
      page,
      limit,
    };
  }

  async transactions(query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const type = parseEnum(query.type, TRANSACTION_TYPES, 'type');

    const { transactions, total } = await transactionRepository.list({
      type,
      orderId: query.order_id,
      vendorId: query.vendor_id,
      driverId: query.driver_id,
      limit,
      offset,
    });

    return {
      items: transactions.map(serializeTransaction),
      total,
      page,
      limit,
    };
  }
}

module.exports = new AdminPlatformService();
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;

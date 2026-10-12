const { PlatformAccount } = require('../models');

const PRIMARY_KEY = 'primary';

/**
 * The platform (system admin) money account. Held funds back every successful
 * customer payment; settlement moves commission to the platform and the rest
 * out to the vendor and rider.
 */
class PlatformAccountRepository {
  async getOrCreate() {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      { $setOnInsert: { key: PRIMARY_KEY } },
      { upsert: true, new: true, lean: true }
    );
  }

  /** Customer payment received: hold the full amount (escrow). */
  async hold({ amountRwf = 0 }) {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      {
        $inc: {
          held_balance_rwf: amountRwf,
          total_collected_rwf: amountRwf,
        },
      },
      { upsert: true, new: true, lean: true }
    );
  }

  /**
   * Order completed: release held funds. Commission is retained by the
   * platform, vendor and rider payouts are booked as outgoing.
   */
  async settle({
    heldRwf = 0,
    commissionRwf = 0,
    vendorPayoutRwf = 0,
    riderPayoutRwf = 0,
  }) {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      {
        $inc: {
          held_balance_rwf: -heldRwf,
          commission_balance_rwf: commissionRwf,
          total_commission_rwf: commissionRwf,
          total_vendor_payouts_rwf: vendorPayoutRwf,
          total_driver_payouts_rwf: riderPayoutRwf,
        },
      },
      { upsert: true, new: true, lean: true }
    );
  }

  /** Order cancelled/refunded: release the held amount back out. */
  async refund({ amountRwf = 0 }) {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      {
        $inc: {
          held_balance_rwf: -amountRwf,
          total_refunded_rwf: amountRwf,
        },
      },
      { upsert: true, new: true, lean: true }
    );
  }
}

module.exports = new PlatformAccountRepository();
module.exports.PRIMARY_KEY = PRIMARY_KEY;

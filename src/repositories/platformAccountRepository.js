const { PlatformAccount } = require('../models');

const PRIMARY_KEY = 'primary';

/**
 * Stores the latest computed snapshot of the platform's books. Balances are
 * never incremented here; they are recomputed from the sources of truth by
 * `platformLedgerService.snapshot()` so they cannot drift.
 */
class PlatformAccountRepository {
  async getOrCreate() {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      { $setOnInsert: { key: PRIMARY_KEY } },
      { upsert: true, new: true, lean: true }
    );
  }

  async saveSnapshot(snapshot) {
    return PlatformAccount.findOneAndUpdate(
      { key: PRIMARY_KEY },
      { $set: { ...snapshot, key: PRIMARY_KEY } },
      { upsert: true, new: true, lean: true }
    );
  }
}

module.exports = new PlatformAccountRepository();
module.exports.PRIMARY_KEY = PRIMARY_KEY;

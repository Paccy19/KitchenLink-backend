const config = require('../config');
const { OwnerPayoutSettings } = require('../models');

const { sweep } = config.admin.owner;

class OwnerPayoutSettingsRepository {
  /** Saved settings, created with the env defaults on first read. */
  async get() {
    return OwnerPayoutSettings.findOneAndUpdate(
      { key: 'primary' },
      {
        $setOnInsert: {
          key: 'primary',
          schedule: {
            mode: sweep.enabled ? 'reminder' : 'off',
            frequency: 'weekly',
            weekday: sweep.weekday,
            day_of_month: 1,
            hour: sweep.hour,
            amount_mode: 'all_available',
            fixed_amount_rwf: 0,
          },
        },
      },
      { upsert: true, new: true, lean: true }
    );
  }

  async save(update) {
    return OwnerPayoutSettings.findOneAndUpdate(
      { key: 'primary' },
      { $set: { ...update, key: 'primary' } },
      { upsert: true, new: true, lean: true }
    );
  }
}

module.exports = new OwnerPayoutSettingsRepository();

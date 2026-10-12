const config = require('../config');
const commissionRepository = require('../repositories/commissionRepository');

/**
 * Single source of truth for the platform commission percentage. Resolution
 * order: the most specific active Commission config (vendor > category >
 * vendor_type > global), falling back to the configured default (15%).
 */
class CommissionService {
  async resolvePercent({ vendorId, categoryId, vendorType } = {}) {
    try {
      const row = await commissionRepository.findApplicable({
        vendorId,
        categoryId,
        vendorType,
      });
      if (row && Number.isFinite(row.percentage)) return row.percentage;
    } catch {
      /* fall through to config default */
    }
    return config.admin.commissionDefaultPercent;
  }

  async globalPercent() {
    try {
      const row = await commissionRepository.findGlobal();
      if (row && Number.isFinite(row.percentage)) return row.percentage;
    } catch {
      /* fall through to config default */
    }
    return config.admin.commissionDefaultPercent;
  }
}

module.exports = new CommissionService();

const config = require('../config');
const { todayRange } = require('../utils/time');
const { serializeVendorDashboard } = require('../utils/serializers');
const orderRepository = require('../repositories/orderRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const commissionService = require('./commissionService');

class VendorDashboardService {
  async overview(vendor) {
    const { start, end } = todayRange(config.vendor.timezoneOffsetHours);

    const [metrics, withdrawnRwf, commissionPercent] = await Promise.all([
      orderRepository.dashboardMetrics(vendor._id, {
        start,
        end,
        pendingStatuses: config.vendor.pendingInternalStatuses,
      }),
      withdrawalRepository.totalWithdrawn(vendor._id),
      commissionService.globalPercent(),
    ]);

    return serializeVendorDashboard({
      ...metrics,
      totalSalesRwf: vendor.total_sales ?? 0,
      availableBalanceRwf: vendor.available_balance ?? 0,
      commissionPercent,
      withdrawnRwf,
    });
  }
}

module.exports = new VendorDashboardService();

const config = require('../config');
const { todayRange } = require('../utils/time');
const { serializeVendorDashboard } = require('../utils/serializers');
const orderRepository = require('../repositories/orderRepository');

class VendorDashboardService {
  async overview(vendor) {
    const { start, end } = todayRange(config.vendor.timezoneOffsetHours);

    const metrics = await orderRepository.dashboardMetrics(vendor._id, {
      start,
      end,
      pendingStatuses: config.vendor.pendingInternalStatuses,
    });

    return serializeVendorDashboard({
      ...metrics,
      totalSalesRwf: vendor.total_sales ?? 0,
      availableBalanceRwf: vendor.available_balance ?? 0,
    });
  }
}

module.exports = new VendorDashboardService();

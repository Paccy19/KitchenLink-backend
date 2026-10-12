const config = require('../config');
const { todayRange } = require('../utils/time');
const { serializeAdminOrder } = require('../utils/serializers');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const customerRepository = require('../repositories/customerRepository');
const driverRepository = require('../repositories/driverRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const complaintRepository = require('../repositories/complaintRepository');
const commissionRepository = require('../repositories/commissionRepository');

const COMPLETED_STATUSES = ['delivered'];
const PENDING_STATUSES = config.vendor.pendingInternalStatuses;

class AdminDashboardService {
  async overview() {
    const { start, end } = todayRange(config.vendor.timezoneOffsetHours);
    const commissionConfig = await commissionRepository.findGlobal();
    const commissionPercent =
      commissionConfig?.percentage ?? config.admin.commissionDefaultPercent;

    const [
      ordersToday,
      pendingOrders,
      liveOrders,
      salesToday,
      orderStatusCounts,
      vendorCounts,
      customerTotal,
      customerActive,
      driverCounts,
      driverOnline,
      activeDeliveries,
      openComplaints,
      recentOrders,
    ] = await Promise.all([
      orderRepository.countCreatedBetween(start, end),
      orderRepository.countByStatuses(PENDING_STATUSES),
      orderRepository.countByStatuses(
        config.orders.statuses.filter(
          (status) => status !== 'delivered' && status !== 'cancelled'
        )
      ),
      orderRepository.salesTotalsBetween({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
      }),
      orderRepository.countByStatuses(config.orders.statuses),
      vendorRepository.countsByVerification(),
      customerRepository.countAll(),
      customerRepository.countActive(),
      driverRepository.countsByVerification(),
      driverRepository.countOnline(),
      deliveryRepository.countActive(config.delivery.activeStatuses),
      complaintRepository.countOpen(),
      orderRepository.adminList({ limit: 5, offset: 0 }),
    ]);

    const pendingCount = Object.values(pendingOrders || {}).reduce(
      (sum, value) => sum + value,
      0
    );
    const liveCount = Object.values(liveOrders || {}).reduce(
      (sum, value) => sum + value,
      0
    );
    const vendorTotal = Object.values(vendorCounts).reduce((sum, value) => sum + value, 0);
    const driverTotal = Object.values(driverCounts).reduce((sum, value) => sum + value, 0);

    return {
      today: {
        orders: ordersToday,
        sales_rwf: salesToday.gross,
        completed_orders: salesToday.orders,
        delivery_fees_rwf: salesToday.delivery_fees,
        commission_rwf: Math.round(
          Math.max(0, salesToday.gross - salesToday.delivery_fees) * (commissionPercent / 100)
        ),
      },
      orders: {
        pending: pendingCount,
        live: liveCount,
        by_status: config.orders.statuses.map((status) => ({
          status,
          label: config.orders.statusLabels[status] || status,
          count: orderStatusCounts[status] || 0,
        })),
      },
      vendors: {
        total: vendorTotal,
        pending: vendorCounts.pending || 0,
        approved: vendorCounts.approved || 0,
        rejected: vendorCounts.rejected || 0,
        suspended: vendorCounts.suspended || 0,
      },
      customers: {
        total: customerTotal,
        active: customerActive,
      },
      drivers: {
        total: driverTotal,
        online: driverOnline,
        pending: driverCounts.pending || 0,
        approved: driverCounts.approved || 0,
        suspended: driverCounts.suspended || 0,
      },
      deliveries: {
        active: activeDeliveries,
      },
      complaints: {
        open: openComplaints,
      },
      commission_percent: commissionPercent,
      recent_orders: recentOrders.orders.map(serializeAdminOrder),
    };
  }
}

module.exports = new AdminDashboardService();

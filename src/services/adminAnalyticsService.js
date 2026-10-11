const config = require('../config');
const { parseDateRange, parseEnum } = require('../utils/adminValidators');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const customerRepository = require('../repositories/customerRepository');
const driverRepository = require('../repositories/driverRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const complaintRepository = require('../repositories/complaintRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const commissionRepository = require('../repositories/commissionRepository');

const COMPLETED_STATUSES = ['delivered'];
const GRANULARITIES = ['day', 'hour'];

class AdminAnalyticsService {
  async overview(query = {}) {
    const { start, end } = this.#resolveRange(query);
    const commissionConfig = await commissionRepository.findGlobal();
    const commissionPercent =
      commissionConfig?.percentage ?? config.admin.commissionDefaultPercent;

    const [
      sales,
      ordersCreated,
      topVendors,
      newCustomers,
      newVendors,
      newDrivers,
      deliveryCounts,
      complaintCounts,
      vendorTotals,
    ] = await Promise.all([
      orderRepository.salesTotalsBetween({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
      }),
      orderRepository.countCreatedBetween(start, end),
      orderRepository.topVendors({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
        limit: 5,
      }),
      customerRepository.countSince(start),
      vendorRepository.countSince(start),
      driverRepository.countSince(start),
      deliveryRepository.countsByStatus(),
      complaintRepository.countsByStatus(),
      vendorRepository.platformTotals(),
    ]);

    return {
      range: { from: start, to: end },
      sales: {
        gross_rwf: sales.gross,
        orders: sales.orders,
        delivery_fees_rwf: sales.delivery_fees,
        commission_rwf: Math.round(sales.gross * (commissionPercent / 100)),
        commission_percent: commissionPercent,
      },
      orders_created: ordersCreated,
      top_vendors: topVendors.map((row) => ({
        vendor_id: row.vendor_id ? String(row.vendor_id) : null,
        name: row.name || 'Unknown vendor',
        orders: row.orders,
        gross_rwf: row.gross_rwf,
      })),
      signups: {
        customers: newCustomers,
        vendors: newVendors,
        drivers: newDrivers,
      },
      deliveries_by_status: deliveryCounts,
      complaints_by_status: complaintCounts,
      platform: {
        total_sales_rwf: vendorTotals.total_sales,
        vendor_balances_rwf: vendorTotals.available_balance,
      },
    };
  }

  async sales(query = {}) {
    const { start, end } = this.#resolveRange(query);
    const granularity = parseEnum(query.granularity, GRANULARITIES, 'granularity') || 'day';
    const [series, totals, topVendors] = await Promise.all([
      orderRepository.salesSeries({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
        granularity,
        timezoneOffsetHours: config.vendor.timezoneOffsetHours,
      }),
      orderRepository.salesTotalsBetween({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
      }),
      orderRepository.topVendors({
        start,
        end,
        completedStatuses: COMPLETED_STATUSES,
        limit: 10,
      }),
    ]);

    return {
      range: { from: start, to: end },
      granularity,
      series,
      totals: {
        gross_rwf: totals.gross,
        orders: totals.orders,
        delivery_fees_rwf: totals.delivery_fees,
        average_order_rwf: totals.orders > 0 ? Math.round(totals.gross / totals.orders) : 0,
      },
      top_vendors: topVendors.map((row) => ({
        vendor_id: row.vendor_id ? String(row.vendor_id) : null,
        name: row.name || 'Unknown vendor',
        orders: row.orders,
        gross_rwf: row.gross_rwf,
      })),
    };
  }

  async payouts(query = {}) {
    const { start, end } = this.#resolveRange(query);
    const [withdrawalRows, vendorTotals, topBalances] = await Promise.all([
      withdrawalRepository.totalsByStatus(),
      vendorRepository.platformTotals(),
      vendorRepository.listBalances({ sort: 'balance', limit: 10, offset: 0 }),
    ]);

    return {
      range: { from: start, to: end },
      withdrawals_by_status: withdrawalRows.map((row) => ({
        status: row._id,
        total_rwf: row.total,
        count: row.count,
      })),
      platform: {
        total_sales_rwf: vendorTotals.total_sales,
        vendor_balances_rwf: vendorTotals.available_balance,
      },
      top_vendor_balances: topBalances.vendors.map((vendor) => ({
        vendor_id: String(vendor._id),
        name: vendor.name,
        available_balance_rwf: vendor.available_balance ?? 0,
        total_sales_rwf: vendor.total_sales ?? 0,
      })),
    };
  }

  #resolveRange(query = {}) {
    const { from, to } = parseDateRange(query);
    const end = to || new Date();
    const start =
      from ||
      new Date(
        end.getTime() - 30 * 24 * 60 * 60 * 1000
      );
    return { start, end };
  }
}

module.exports = new AdminAnalyticsService();

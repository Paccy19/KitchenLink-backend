const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const transactionRepository = require('../repositories/transactionRepository');
const commissionService = require('./commissionService');

const roundRwf = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * Money flow for orders (see platformLedgerService for the resulting books):
 *
 *  1. Customer pays   -> food + delivery is held by the platform
 *                        (`onPaymentSuccess`, cash in).
 *  2. Order completes -> the food part is allocated: the platform keeps its
 *                        commission (on the food subtotal only) and now OWES
 *                        the vendor `subtotal - commission` (`releaseOrder`).
 *  3. Rider delivers  -> the delivery fee is allocated: the platform now OWES
 *                        the rider the full fee (`recordDriverPayout`).
 *  4. Withdrawal paid -> owed money actually leaves (adminPayoutService).
 *  Cancelled before completion -> the held amount is refunded (`refundOrder`).
 *
 * Only money that was actually received is ever allocated, and every step is
 * idempotent so the vendor, rider, admin and agent paths can all call it.
 */
class SettlementService {
  /** Compute the payout split for an order (commission is on food only). */
  async #computeSplit(order, percentOverride) {
    const subtotal = roundRwf(order.subtotal_rwf);
    const deliveryFee = roundRwf(order.delivery_fee_rwf);
    // The order's stored percent is only a snapshot once settlement has begun;
    // before that it is the schema default (0) and must not be trusted.
    const snapshotPercent =
      order.settlement_status !== 'unpaid' ? order.commission_percent : null;
    const percent =
      percentOverride ??
      snapshotPercent ??
      (await commissionService.resolvePercent({ vendorId: order.vendor_id }));

    const commissionRwf =
      order.commission_rwf != null && order.settlement_status !== 'unpaid'
        ? roundRwf(order.commission_rwf)
        : roundRwf((subtotal * percent) / 100);
    const vendorPayout =
      order.vendor_payout_rwf != null && order.settlement_status !== 'unpaid'
        ? roundRwf(order.vendor_payout_rwf)
        : subtotal - commissionRwf;
    const riderPayout =
      order.rider_payout_rwf != null && order.settlement_status !== 'unpaid'
        ? roundRwf(order.rider_payout_rwf)
        : deliveryFee;

    return {
      subtotal,
      deliveryFee,
      percent,
      commissionRwf,
      vendorPayout: Math.max(0, vendorPayout),
      riderPayout: Math.max(0, riderPayout),
      total: roundRwf(order.total_rwf) || subtotal + deliveryFee,
    };
  }

  /**
   * Customer payment succeeded: snapshot the split and hold the full amount.
   * If the order was already completed while unpaid, settle it right away.
   */
  async onPaymentSuccess(order) {
    if (!order) return null;
    if (order.settlement_status === 'held' || order.settlement_status === 'settled') {
      return order;
    }

    const split = await this.#computeSplit(order, null);

    const claimed = await orderRepository.claimSettlement(order._id, 'unpaid', 'held', {
      commission_percent: split.percent,
      commission_rwf: split.commissionRwf,
      vendor_payout_rwf: split.vendorPayout,
      rider_payout_rwf: split.riderPayout,
    });
    if (!claimed) return orderRepository.findById(order._id);

    await transactionRepository.create({
      type: 'order_payment',
      direction: 'credit',
      status: 'held',
      amount_rwf: split.total,
      order_id: order._id,
      customer_id: order.customer_id,
      reference: order.order_number || '',
      description: `Customer payment held for ${order.order_number}`,
      metadata: {
        subtotal_rwf: split.subtotal,
        delivery_fee_rwf: split.deliveryFee,
        commission_percent: split.percent,
        commission_rwf: split.commissionRwf,
      },
    });

    const fresh = await orderRepository.findById(order._id);
    if (fresh?.status === 'delivered') {
      return this.releaseOrder(order._id);
    }
    return fresh;
  }

  /**
   * Order completed: allocate the held food money. The platform keeps its
   * commission and owes the vendor the rest (credited to their balance). The
   * delivery fee stays held until a rider is credited for it. Unpaid orders
   * are not settled: nothing was received to pay anyone with.
   */
  async releaseOrder(orderId) {
    const order = await orderRepository.findById(orderId);
    if (!order) return null;
    if (order.settlement_status !== 'held') return order;

    const split = await this.#computeSplit(order, null);
    const claimed = await orderRepository.claimSettlement(order._id, 'held', 'settled', {
      commission_percent: split.percent,
      commission_rwf: split.commissionRwf,
      vendor_payout_rwf: split.vendorPayout,
      rider_payout_rwf: split.riderPayout,
      settled_at: order.settled_at || new Date(),
    });
    if (!claimed) return orderRepository.findById(order._id);

    // Vendor earns its food revenue (subtotal) and is owed it net of commission.
    await vendorRepository.incrementSales(order.vendor_id, {
      totalRwf: split.subtotal,
      balanceRwf: split.vendorPayout,
    });

    await Promise.all(
      (order.items || []).map((item) =>
        menuItemRepository.incrementOrdersCount(item.menu_item_id, item.quantity)
      )
    );

    await transactionRepository.create({
      type: 'commission',
      direction: 'internal',
      status: 'settled',
      amount_rwf: split.commissionRwf,
      order_id: order._id,
      reference: order.order_number || '',
      description: `Platform commission (${split.percent}%) for ${order.order_number}`,
      metadata: { commission_percent: split.percent, subtotal_rwf: split.subtotal },
    });

    await transactionRepository.create({
      type: 'vendor_earning',
      direction: 'internal',
      status: 'settled',
      amount_rwf: split.vendorPayout,
      order_id: order._id,
      vendor_id: order.vendor_id,
      reference: order.order_number || '',
      description: `Owed to vendor for ${order.order_number}`,
      metadata: {
        subtotal_rwf: split.subtotal,
        commission_rwf: split.commissionRwf,
        commission_percent: split.percent,
      },
    });

    return orderRepository.findById(order._id);
  }

  /**
   * Rider delivered: the platform now owes them the full delivery fee (their
   * balance is credited by the caller). Records the allocation once per order.
   */
  async recordDriverPayout(order, { driverId, amountRwf }) {
    if (!order || !driverId) return null;
    const amount = roundRwf(amountRwf);
    if (amount <= 0) return null;

    const marked = await orderRepository.markRiderSettled(order._id);
    if (!marked?.modifiedCount) return null;

    return transactionRepository.create({
      type: 'driver_earning',
      direction: 'internal',
      status: 'settled',
      amount_rwf: amount,
      order_id: order._id,
      driver_id: driverId,
      reference: order.order_number || '',
      description: `Owed to delivery worker for delivering ${order.order_number}`,
      metadata: { delivery_fee_rwf: amount },
    });
  }

  /**
   * Order cancelled before completion: the held amount becomes owed back to
   * the customer as a refund (`refundService`). The `refund` ledger entry is
   * written when the money is actually sent. Idempotent.
   * `context` = { by: 'customer' | 'vendor' | 'admin' | 'system', reason }.
   */
  async refundOrder(order, context = {}) {
    if (!order) return null;
    const fresh = await orderRepository.claimSettlement(order._id, 'held', 'refunded');
    if (!fresh) return orderRepository.findById(order._id);

    // Required here to avoid a load-order cycle (refundService -> notifications).
    // eslint-disable-next-line global-require
    await require('./refundService').open(fresh, context);
    return fresh;
  }
}

module.exports = new SettlementService();

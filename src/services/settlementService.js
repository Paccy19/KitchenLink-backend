const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const platformAccountRepository = require('../repositories/platformAccountRepository');
const transactionRepository = require('../repositories/transactionRepository');
const commissionService = require('./commissionService');

const roundRwf = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * Money flow for orders:
 *
 *  1. Customer pays  -> the full amount (food + delivery) is held by the
 *     platform (`onPaymentSuccess`).
 *  2. Order completes -> the platform keeps the commission (calculated on the
 *     food subtotal ONLY), credits the vendor `subtotal - commission`, and the
 *     rider keeps the entire delivery fee (`releaseOrder`).
 *
 * Every step is idempotent so the vendor "mark completed" path and the rider
 * OTP-confirmation path can both call it safely.
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
   * Customer payment succeeded: snapshot the split and hold the full amount on
   * the platform account in escrow.
   */
  async onPaymentSuccess(order) {
    if (!order) return null;
    if (order.settlement_status === 'held' || order.settlement_status === 'settled') {
      return order;
    }

    const split = await this.#computeSplit(order, null);

    await orderRepository.update(order._id, {
      commission_percent: split.percent,
      commission_rwf: split.commissionRwf,
      vendor_payout_rwf: split.vendorPayout,
      rider_payout_rwf: split.riderPayout,
      settlement_status: 'held',
    });

    await platformAccountRepository.hold({ amountRwf: split.total });

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

    return orderRepository.findById(order._id);
  }

  /**
   * Order completed: release held funds. Credits the vendor and books the
   * platform commission. Idempotent via the order's settlement_status.
   */
  async releaseOrder(orderId, { driverId = null } = {}) {
    const order = await orderRepository.findById(orderId);
    if (!order) return null;
    if (order.settlement_status === 'settled' || order.settlement_status === 'refunded') {
      return order;
    }

    const split = await this.#computeSplit(order, null);
    const wasHeld = order.settlement_status === 'held';

    if (wasHeld) {
      await platformAccountRepository.settle({
        heldRwf: split.total,
        commissionRwf: split.commissionRwf,
        vendorPayoutRwf: split.vendorPayout,
        riderPayoutRwf: split.riderPayout,
      });
    }

    // Vendor earns its food revenue (subtotal) and is credited net of commission.
    await vendorRepository.incrementSales(order.vendor_id, {
      totalRwf: split.subtotal,
      balanceRwf: split.vendorPayout,
    });

    await Promise.all(
      (order.items || []).map((item) =>
        menuItemRepository.incrementOrdersCount(item.menu_item_id, item.quantity)
      )
    );

    if (wasHeld) {
      await transactionRepository.create({
        type: 'commission',
        direction: 'credit',
        status: 'settled',
        amount_rwf: split.commissionRwf,
        order_id: order._id,
        reference: order.order_number || '',
        description: `Platform commission (${split.percent}%) for ${order.order_number}`,
        metadata: { commission_percent: split.percent, subtotal_rwf: split.subtotal },
      });
    }

    await transactionRepository.create({
      type: 'vendor_payout',
      direction: 'debit',
      status: 'settled',
      amount_rwf: split.vendorPayout,
      order_id: order._id,
      vendor_id: order.vendor_id,
      reference: order.order_number || '',
      description: `Vendor payout for ${order.order_number}`,
      metadata: {
        subtotal_rwf: split.subtotal,
        commission_rwf: split.commissionRwf,
        commission_percent: split.percent,
      },
    });

    await orderRepository.update(order._id, {
      commission_percent: split.percent,
      commission_rwf: split.commissionRwf,
      vendor_payout_rwf: split.vendorPayout,
      rider_payout_rwf: split.riderPayout,
      settlement_status: 'settled',
      settled_at: order.settled_at || new Date(),
    });

    return orderRepository.findById(order._id);
  }

  /**
   * Rider completed a delivery: the rider keeps the whole delivery fee. Records
   * the ledger entry; the driver's earnings counter is updated by the caller.
   */
  async recordDriverPayout(order, { driverId, amountRwf }) {
    if (!order || !driverId) return null;
    const amount = roundRwf(amountRwf);
    if (amount <= 0) return null;
    return transactionRepository.create({
      type: 'driver_payout',
      direction: 'debit',
      status: 'settled',
      amount_rwf: amount,
      order_id: order._id,
      driver_id: driverId,
      reference: order.order_number || '',
      description: `Rider delivery fee for ${order.order_number}`,
      metadata: { delivery_fee_rwf: amount },
    });
  }

  /** Order cancelled/refunded: return the held amount. Idempotent. */
  async refundOrder(order) {
    if (!order) return null;
    if (order.settlement_status !== 'held') return order;

    const amount = roundRwf(order.total_rwf);
    await platformAccountRepository.refund({ amountRwf: amount });
    await transactionRepository.create({
      type: 'refund',
      direction: 'debit',
      status: 'refunded',
      amount_rwf: amount,
      order_id: order._id,
      customer_id: order.customer_id,
      reference: order.order_number || '',
      description: `Refund for ${order.order_number}`,
    });
    await orderRepository.update(order._id, { settlement_status: 'refunded' });
    return order;
  }
}

module.exports = new SettlementService();

const platformAccountRepository = require('../repositories/platformAccountRepository');
const transactionRepository = require('../repositories/transactionRepository');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const driverRepository = require('../repositories/driverRepository');
const withdrawalRepository = require('../repositories/withdrawalRepository');
const paymentRepository = require('../repositories/paymentRepository');
const deliveryRepository = require('../repositories/deliveryRepository');
const platformWithdrawalRepository = require('../repositories/platformWithdrawalRepository');
const refundRepository = require('../repositories/refundRepository');

/**
 * The platform's books, computed from the sources of truth instead of running
 * counters. All customer money sits in one real account:
 *
 *   cash = collected - refunded - paid out (completed withdrawals)
 *
 * and that cash is made of:
 *
 *   held      paid orders not yet completed + delivery fees awaiting a rider
 *   vendors   what vendors are owed (balances + payouts being processed)
 *   riders    what riders are owed  (balances + payouts being processed)
 *   commission the owner's money: commission earned + adjustments + late-pickup
 *              penalties - what the owner already withdrew
 *   refunds   cancelled paid orders whose money is not yet sent back
 *              (a `refund` entry is written only when it is sent)
 *
 * The two sides are computed independently (ledger cash flows vs. order and
 * balance state), so `unreconciled_rwf` exposes any money that was credited
 * without being received, or lost: it should always be 0.
 */
class PlatformLedgerService {
  async snapshot() {
    const [
      collected,
      refunded,
      commission,
      vendorEarnings,
      driverEarnings,
      driverPenalties,
      vendorPaidOut,
      driverPaidOut,
      held,
      vendorBalances,
      driverBalances,
      vendorProcessing,
      driverProcessing,
      adjustments,
      ownerPaidOut,
      ownerProcessing,
      refundsOwed,
    ] = await Promise.all([
      transactionRepository.sum({ type: 'order_payment' }),
      transactionRepository.sum({ type: 'refund' }),
      transactionRepository.sum({ type: 'commission' }),
      transactionRepository.sum({ type: 'vendor_earning' }),
      transactionRepository.sum({ type: 'driver_earning' }),
      transactionRepository.sum({ type: 'driver_penalty' }),
      transactionRepository.sum({ type: 'withdrawal', vendor_id: { $ne: null } }),
      transactionRepository.sum({ type: 'withdrawal', driver_id: { $ne: null } }),
      orderRepository.heldTotal(),
      vendorRepository.totalBalances(),
      driverRepository.totalBalances(),
      withdrawalRepository.totalProcessing('vendor'),
      withdrawalRepository.totalProcessing('driver'),
      transactionRepository.sum({ type: 'adjustment' }),
      transactionRepository.sum({ type: 'platform_withdrawal' }),
      platformWithdrawalRepository.sum({ status: 'processing' }),
      refundRepository.totalOwed(),
    ]);

    const cash = collected - refunded - vendorPaidOut - driverPaidOut - ownerPaidOut;
    const vendorPayable = vendorBalances + vendorProcessing;
    const driverPayable = driverBalances + driverProcessing;
    const ownerBalance = commission + adjustments + driverPenalties - ownerPaidOut;
    const accountedFor = held + vendorPayable + driverPayable + ownerBalance + refundsOwed;

    return platformAccountRepository.saveSnapshot({
      cash_balance_rwf: cash,
      held_balance_rwf: held,
      vendor_payable_rwf: vendorPayable,
      driver_payable_rwf: driverPayable,
      refunds_owed_rwf: refundsOwed,
      commission_balance_rwf: ownerBalance,
      unreconciled_rwf: cash - accountedFor,
      total_adjustments_rwf: adjustments,
      total_driver_penalties_rwf: driverPenalties,
      total_owner_withdrawn_rwf: ownerPaidOut,
      owner_processing_rwf: ownerProcessing,
      total_collected_rwf: collected,
      total_refunded_rwf: refunded,
      total_commission_rwf: commission,
      total_vendor_earnings_rwf: vendorEarnings,
      total_driver_earnings_rwf: driverEarnings,
      total_vendor_payouts_rwf: vendorPaidOut,
      total_driver_payouts_rwf: driverPaidOut,
      computed_at: new Date(),
    });
  }

  /**
   * One-off upgrade of ledgers written before owed money was tracked:
   * `vendor_payout`/`driver_payout` entries were allocations, not cash leaving,
   * so they become `vendor_earning`/`driver_earning`; orders whose rider was
   * already credited are marked so their delivery fee is no longer held.
   * Safe to run on every startup.
   */
  async migrateLegacyLedger() {
    const renamed = await transactionRepository.migrateLegacyTypes();
    const riderEntries = await transactionRepository.listDriverEarningOrders();
    await Promise.all(
      riderEntries.map((entry) => orderRepository.markRiderSettled(entry.order_id, entry.created_at))
    );
    const backfilled = await this.#backfillMissingPayments();
    const refunds = await this.#backfillRefundRecords();
    return { renamed, backfilled, refunds };
  }

  /**
   * Refunds recorded before refunds were tracked were written to the ledger
   * as already sent; give each one its completed refund record so customers
   * and admins see it.
   */
  async #backfillRefundRecords() {
    const entries = await transactionRepository.listLegacyRefunds();
    let count = 0;
    for (const entry of entries) {
      if (await refundRepository.findByOrder(entry.order_id)) continue;
      const order = await orderRepository.findById(entry.order_id);
      if (!order) continue;
      const card = order.payment_method === 'card';
      await refundRepository.createOnce({
        order_id: order._id,
        order_number: order.order_number || '',
        customer_id: order.customer_id,
        vendor_id: order.vendor_id || null,
        amount_rwf: entry.amount_rwf,
        payment_method: order.payment_method || '',
        destination: card
          ? { type: 'card', card_last4: String(order.payment_details?.card_number || '').slice(-4) }
          : { type: 'mobile_money', phone: order.payment_details?.phone || '' },
        status: 'completed',
        provider: 'legacy',
        reference: entry.reference || '',
        reason: order.cancel_reason || '',
        completed_at: entry.created_at,
      });
      count += 1;
    }
    return count;
  }

  /**
   * Orders paid before the ledger existed have no `order_payment` entry, so
   * their cash is missing from the books. Record it from the successful
   * payment. Completed orders were already paid out by the old code, so they
   * are marked settled (nobody is credited again); open ones are held.
   */
  async #backfillMissingPayments() {
    const recorded = await transactionRepository.orderIdsWithType('order_payment');
    const orders = await orderRepository.listPaidExcept(recorded);
    let count = 0;

    for (const order of orders) {
      const payment = await paymentRepository.findSuccessfulByOrder(order._id);
      if (!payment) continue;

      await transactionRepository.create({
        type: 'order_payment',
        direction: 'credit',
        status: 'held',
        amount_rwf: Math.round(order.total_rwf || payment.amount_rwf || 0),
        order_id: order._id,
        customer_id: order.customer_id,
        reference: order.order_number || '',
        description: `Customer payment for ${order.order_number} (recorded from payment history)`,
        metadata: { backfilled: true, payment_id: String(payment._id) },
      });

      if (!order.settlement_status || order.settlement_status === 'unpaid') {
        const completed = order.status === 'delivered';
        if (order.status !== 'cancelled') {
          await orderRepository.update(order._id, {
            settlement_status: completed ? 'settled' : 'held',
            ...(completed ? { settled_at: order.completed_at || order.delivered_at || new Date() } : {}),
          });
        }
        // A rider who already delivered it was credited by the old code.
        const delivery = completed ? await deliveryRepository.findByOrderId(order._id) : null;
        if (delivery?.status === 'completed' || delivery?.status === 'delivered') {
          await orderRepository.markRiderSettled(order._id, delivery.completed_at || new Date());
        }
      }
      count += 1;
    }
    return count;
  }
}

module.exports = new PlatformLedgerService();

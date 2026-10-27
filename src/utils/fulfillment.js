/**
 * How an order reaches the customer (order.fulfillment):
 *  - 'delivery': a platform delivery worker brings it (old orders have no field),
 *  - 'pickup': the customer collects it at the kitchen,
 *  - 'vendor_delivery': a nationwide kitchen brings it itself (too far for
 *    platform workers).
 * Pickup and kitchen-delivered orders never get a delivery worker: the kitchen
 * completes them by entering the customer's code at handover.
 */
const HANDOVER_CODE_FULFILLMENTS = ['pickup', 'vendor_delivery'];

const fulfillmentOf = (order) => order?.fulfillment || 'delivery';
const usesHandoverCode = (order) => HANDOVER_CODE_FULFILLMENTS.includes(fulfillmentOf(order));
const isKitchenDelivered = (order) => fulfillmentOf(order) === 'vendor_delivery';

/** A two-part order (big event) whose second half isn't paid yet. */
const balanceUnpaid = (order) => order?.deposit?.balance_rwf != null && !order.deposit.balance_paid_at;

module.exports = { HANDOVER_CODE_FULFILLMENTS, fulfillmentOf, usesHandoverCode, isKitchenDelivered, balanceUnpaid };

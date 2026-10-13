const notificationService = require('./notificationService');

/**
 * Order and account events turned into in-app notifications, each linking to
 * the exact page that deals with it. All calls are fire-and-forget: a failed
 * notification never breaks the action that triggered it.
 */
const money = (value) => `${Math.round(Number(value) || 0).toLocaleString()} RWF`;
const vendorOrderLink = (orderId) => `/vendor-dashboard/orders?order=${orderId}`;
const ref = (order) => order.order_number || 'your order';
const quietly = (promise) => Promise.resolve(promise).catch(() => null);

const toVendor = (order, title, body, type = 'order_update') =>
  quietly(
    notificationService.notifyVendor(order.vendor_id, {
      type,
      title,
      body,
      orderId: order._id,
      link: vendorOrderLink(order._id),
      data: { order_number: order.order_number || null },
    })
  );

const toCustomer = (order, title, body) =>
  quietly(
    notificationService.notifyCustomerOrder(order.customer_id, {
      orderId: order._id,
      orderNumber: order.order_number,
      title,
      body,
    })
  );

module.exports = {
  /** A paid order reached the kitchen. */
  newOrder(order) {
    const when =
      order.order_type && order.order_type !== 'immediate' && order.scheduled_for
        ? ` for ${new Date(order.scheduled_for).toLocaleString('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short' })}`
        : '';
    return toVendor(order, 'New order', `${ref(order)} · ${money(order.subtotal_rwf ?? order.total_rwf)} of food${when}. Accept it to start preparing.`, 'order_placed');
  },

  customerCancelled(order, reason) {
    return toVendor(order, 'Order cancelled by the customer', `${ref(order)} was cancelled${reason ? `: ${reason}` : '.'} Stop preparing it.`);
  },

  /** Kitchen moves: the customer follows along. */
  kitchenAccepted(order) {
    return toCustomer(order, 'Order accepted', `The kitchen accepted ${ref(order)} and will start preparing it.`);
  },

  kitchenCancelled(order, reason) {
    return toCustomer(
      order,
      'Order cancelled',
      `The kitchen cancelled ${ref(order)}${reason ? ` (${reason})` : ''}.${order.payment_status === 'paid' ? ' Your payment is being refunded.' : ''}`
    );
  },

  deliveryAccepted(order, workerName) {
    return toVendor(order, 'Delivery worker on the way', `${workerName || 'A delivery worker'} accepted ${ref(order)} and is coming to collect it.`);
  },

  /** The delivery worker confirmed the customer's code. */
  completed(order) {
    return Promise.all([
      toVendor(
        order,
        'Order completed',
        `${ref(order)} was delivered. ${money(order.vendor_payout_rwf)} was added to your wallet.`
      ),
      toCustomer(order, 'Order delivered', `${ref(order)} was delivered. Enjoy your meal!`),
    ]);
  },

  /** Admin actions on an order. */
  adminCancelled(order, reason) {
    return Promise.all([
      toVendor(order, 'Order cancelled by support', `${ref(order)} was cancelled by Online Food Kitchen support${reason ? `: ${reason}` : '.'}`),
      toCustomer(
        order,
        'Order cancelled',
        `${ref(order)} was cancelled by support${reason ? ` (${reason})` : ''}.${order.payment_status === 'paid' ? ' Your payment is being refunded.' : ''}`
      ),
    ]);
  },

  vendorPayout(withdrawal, { status, reference, reason } = {}) {
    const paid = status === 'completed';
    return quietly(
      notificationService.notifyVendor(withdrawal.vendor_id, {
        type: 'payout_update',
        title: paid ? 'Payout sent' : 'Payout failed',
        body: paid
          ? `${money(withdrawal.amount_rwf)} was sent via ${withdrawal.method_label || 'mobile money'}${reference ? ` (ref ${reference})` : ''}.`
          : `Your ${money(withdrawal.amount_rwf)} payout could not be sent${reason ? `: ${reason}` : ''}. The money is back in your balance.`,
        link: '/vendor-dashboard/wallet',
        data: { withdrawal_id: String(withdrawal._id), status },
      })
    );
  },

  vendorAccount(vendorId, status, reason) {
    const messages = {
      approved: ['Your kitchen is approved', 'Open your store and share your location to start receiving orders.'],
      rejected: ['Application not approved', `Your kitchen application was not approved${reason ? `: ${reason}` : '.'} Contact support for help.`],
      suspended: ['Your kitchen is suspended', `Your kitchen was suspended${reason ? `: ${reason}` : '.'} Open orders were cancelled and refunded.`],
      pending: ['Your kitchen is under review', 'Your account is being reviewed again by Online Food Kitchen.'],
    };
    const [title, body] = messages[status] || [];
    if (!title) return null;
    return quietly(notificationService.notifyVendor(vendorId, { type: 'account_update', title, body, link: '/vendor-dashboard' }));
  },
};

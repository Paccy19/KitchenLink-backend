const orderRepository = require('../repositories/orderRepository');
const notificationService = require('./notificationService');

const HOUR = 60 * 60 * 1000;
const formatRwf = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')} RWF`;
const formatWhen = (date) =>
  new Date(date).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Kigali',
  });

/**
 * Big events are paid in two parts: the deposit when ordering and the balance
 * a day before the event (`deposit.balance_due_at`). This reminds customers
 * to pay the balance — two days before it is due, on the day it is due, and
 * once it is late (the kitchen is told then too, since it can't hand the
 * food over until it is paid). Each reminder is sent once per order.
 */
const REMINDERS = [
  { key: 'due_soon', fromHoursBeforeDue: 48 },
  { key: 'due_today', fromHoursBeforeDue: 12 },
  { key: 'overdue', fromHoursBeforeDue: 0 },
];

class EventBalanceService {
  async sendDueReminders(now = new Date()) {
    const orders = await orderRepository.findUnpaidBalances(new Date(now.getTime() + 48 * HOUR));
    let sent = 0;
    for (const order of orders) {
      const dueAt = new Date(order.deposit.balance_due_at);
      // The latest reminder that is due now (earlier ones are skipped if missed).
      const due = [...REMINDERS].reverse().find((r) => now.getTime() >= dueAt.getTime() - r.fromHoursBeforeDue * HOUR);
      if (!due || order.deposit.reminders_sent?.includes(due.key)) continue;
      if (!(await orderRepository.markBalanceReminder(order._id, due.key))) continue;

      const balance = formatRwf(order.deposit.balance_rwf);
      const link = `/track/${order._id}`;
      await notificationService
        .notifyCustomerOrder(order.customer_id, {
          orderId: order._id,
          orderNumber: order.order_number,
          type: 'order_update',
          link,
          title: due.key === 'overdue' ? 'Your event balance is overdue' : 'Pay the balance for your event',
          body:
            due.key === 'overdue'
              ? `The balance of ${balance} for ${order.order_number} was due ${formatWhen(dueAt)}. Pay it now so the kitchen can bring your food.`
              : `Pay the balance of ${balance} for ${order.order_number} by ${formatWhen(dueAt)}.`,
        })
        .catch(() => null);
      if (due.key === 'overdue') {
        await notificationService
          .notifyVendor(order.vendor_id, {
            type: 'order_update',
            title: 'Event balance not paid yet',
            body: `The customer hasn't paid the balance (${balance}) of ${order.order_number}, due ${formatWhen(dueAt)}. Don't hand the food over until it's paid.`,
            orderId: order._id,
            link: `/vendor-dashboard/orders?order=${order._id}`,
          })
          .catch(() => null);
      }
      sent += 1;
    }
    return sent;
  }

  /** Checks for due balance reminders every 15 minutes while the server runs. */
  start(intervalMs = 15 * 60 * 1000) {
    const tick = () =>
      this.sendDueReminders()
        .then((sent) => sent > 0 && console.log(`[events] sent ${sent} event balance reminder(s)`))
        .catch((error) => console.error('[events] balance reminder check failed:', error.message));
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
  }
}

module.exports = new EventBalanceService();

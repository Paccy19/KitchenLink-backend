const { Order, Vendor } = require('../../models');
const alerts = require('./alertService');
const { sendSms } = require('../../utils/sms');

/**
 * Orders nobody has picked up. When an order the kitchen can work on (paid,
 * or paid at the restaurant) still has every ticket waiting after the
 * kitchen's limit (Vendor.operations.escalate_after_minutes, default 5,
 * 0 = off), the managers get an urgent alert and the kitchen's phone an SMS
 * (once an SMS gateway is set up). Each order is warned about once.
 */
const DEFAULT_MINUTES = 5;

class NewOrderWatchService {
  async sweep(now = new Date()) {
    const candidates = await Order.find({
      status: 'placed',
      escalated_at: null,
      created_at: { $lte: now },
      $or: [{ payment_method: 'in_person' }, { payment_status: 'paid' }],
      'tickets.0': { $exists: true },
      tickets: { $not: { $elemMatch: { status: { $in: ['accepted', 'preparing', 'ready'] } } } },
    })
      .select('vendor_id order_number created_at table items')
      .sort({ created_at: 1 })
      .limit(200)
      .lean();
    if (!candidates.length) return 0;
    const vendors = new Map(
      (await Vendor.find({ _id: { $in: [...new Set(candidates.map((o) => String(o.vendor_id)))] } }).select('name phone operations.escalate_after_minutes').lean()).map((v) => [String(v._id), v])
    );
    let warned = 0;
    for (const order of candidates) {
      const vendor = vendors.get(String(order.vendor_id));
      const limit = vendor?.operations?.escalate_after_minutes ?? DEFAULT_MINUTES;
      if (!limit) continue;
      if (now - new Date(order.created_at) < limit * 60 * 1000) continue;
      // Claim it first so two servers (or a restart) warn once.
      const claimed = await Order.findOneAndUpdate({ _id: order._id, escalated_at: null, status: 'placed' }, { $set: { escalated_at: now } }).lean();
      if (!claimed) continue;
      const minutes = Math.round((now - new Date(order.created_at)) / 60000);
      const where = order.table?.label ? `${order.table.label}, ` : '';
      const title = `Waiting ${minutes} min: ${order.order_number}`;
      const body = `${where}${(order.items || []).length} item${(order.items || []).length === 1 ? '' : 's'}. Nobody has accepted it yet.`;
      alerts.emit(order.vendor_id, 'order_alerts', { title, body, link: '/vendor-dashboard/kitchen', permission: 'orders.accept' });
      if (vendor?.phone) {
        sendSms(vendor.phone, `${vendor.name || 'KitchenLink'}: order ${order.order_number} has waited ${minutes} min. ${body}`).catch(() => null);
      }
      warned += 1;
    }
    return warned;
  }

  start(intervalMs = 60 * 1000) {
    const tick = () => this.sweep().catch((error) => console.error('[new order watch]', error.message));
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
  }
}

module.exports = new NewOrderWatchService();

const { KitchenStaff, Order, PackingTask } = require('../../models');
const config = require('../../config');

/**
 * Deliveries the kitchen handles. A coordinator sees every delivery order
 * (platform workers and the kitchen's own couriers), what is packed and who
 * is free. A kitchen driver (`delivery.drive` only) sees just the
 * deliveries given to them, with what they need to deliver: never the bill,
 * other orders, or the kitchen's money.
 */
const FINISHED = ['delivered', 'cancelled'];
const COORDINATOR = ['delivery.view_orders', 'delivery.assign_workers', 'delivery.create_assignments', 'delivery.change_assignments', 'delivery.track'];

const courierStatus = (c) => (c ? (c.status === 'on_the_way' ? 'in_transit' : c.status) : 'unassigned');

class DeliveryBoardService {
  #isCoordinator(kitchen) {
    return COORDINATOR.some((p) => kitchen.can(p));
  }

  async board(kitchen, query = {}) {
    const coordinator = this.#isCoordinator(kitchen) && query.mine !== 'true';
    if (!coordinator) kitchen.assert('delivery.drive');
    const since = new Date(Date.now() - 18 * 3600000);
    const filter = {
      vendor_id: kitchen.vendorId,
      fulfillment: { $in: ['delivery', 'vendor_delivery'] },
      $or: [{ status: { $nin: FINISHED } }, { updated_at: { $gte: since } }],
    };
    if (!coordinator) filter['kitchen_courier.staff_id'] = kitchen.actor.type === 'staff' ? kitchen.actor.id : null;
    const orders = await Order.find(filter).sort({ created_at: 1 }).limit(200).lean();
    const packing = await PackingTask.find({ order_id: { $in: orders.map((o) => o._id) }, kind: 'delivery', status: { $ne: 'cancelled' } }).select('order_id status').lean();
    const packed = new Map(packing.map((p) => [String(p.order_id), p.status]));
    const canSeeAddress = coordinator ? kitchen.can('delivery.view_locations') || kitchen.can('delivery.view_orders') : true;
    const rows = orders.map((o) => {
      const loc = o.delivery_location || {};
      const row = {
        id: String(o._id),
        order_number: o.order_number,
        status: o.status,
        status_label: config.orders.statusLabels[o.status] || o.status,
        fulfillment: o.fulfillment,
        by: o.fulfillment === 'vendor_delivery' ? 'kitchen' : 'kitchenlink',
        courier: o.kitchen_courier ? { staff_id: String(o.kitchen_courier.staff_id), name: o.kitchen_courier.name, status: courierStatus(o.kitchen_courier), attempts: (o.kitchen_courier.attempts || []).length } : null,
        courier_status: o.fulfillment === 'vendor_delivery' ? courierStatus(o.kitchen_courier) : o.driver_id ? 'kitchenlink_worker' : 'waiting_worker',
        packing: packed.get(String(o._id)) || null,
        ready: ['ready', 'assigned', 'picked_up', 'on_the_way', 'delivered'].includes(o.status),
        items: (o.items || []).filter((i) => i.service_status !== 'cancelled').map((i) => ({ name: i.name, quantity: i.quantity })),
        address: canSeeAddress ? [loc.address, loc.neighborhood].filter(Boolean).join(', ') : '',
        landmark: canSeeAddress ? loc.note || '' : '',
        location: canSeeAddress && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) ? { lat: loc.latitude, lng: loc.longitude } : null,
        created_at: o.created_at,
        ready_at: o.ready_at || null,
        last_note: (o.status_history || []).slice(-1)[0]?.note || '',
      };
      if (coordinator) {
        row.total_rwf = o.total_rwf;
        row.payment_status = o.payment_status;
      }
      return row;
    });
    const result = { deliveries: rows, coordinator };
    if (coordinator) {
      const couriers = await KitchenStaff.find({ vendor_id: kitchen.vendorId, is_current: true, deleted_at: null, is_active: { $ne: false } }).select('name').lean();
      const busy = new Map();
      for (const o of orders) {
        if (o.kitchen_courier && !FINISHED.includes(o.status) && !['returned', 'cancelled', 'delivered'].includes(o.kitchen_courier.status)) {
          busy.set(String(o.kitchen_courier.staff_id), (busy.get(String(o.kitchen_courier.staff_id)) || 0) + 1);
        }
      }
      result.couriers = couriers.map((c) => ({ id: String(c._id), name: c.name, active_deliveries: busy.get(String(c._id)) || 0 }));
      result.counts = {
        unassigned: rows.filter((r) => r.by === 'kitchen' && !r.courier && !FINISHED.includes(r.status)).length,
        to_pack: rows.filter((r) => r.packing === 'requested').length,
        on_the_road: rows.filter((r) => ['collected', 'in_transit'].includes(r.courier_status)).length,
        problems: rows.filter((r) => ['failed', 'customer_unavailable', 'returned'].includes(r.courier_status)).length,
      };
    }
    return result;
  }
}

module.exports = new DeliveryBoardService();

const ApiError = require('../utils/ApiError');
const { parseObjectId } = require('../utils/vendorValidators');
const { locateOnRoute } = require('../utils/routeMath');
const { isKitchenReady } = require('../utils/deliveryReady');
const deliveryRepository = require('../repositories/deliveryRepository');
const driverRepository = require('../repositories/driverRepository');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const routeNavigationService = require('./routeNavigationService');

// Recompute the road route when the rider strays this far from it, or after this long.
const OFF_ROUTE_M = 60;
const ROUTE_MAX_AGE_MS = 90 * 1000;
// A position older than this is shown as "last seen".
const STALE_LOCATION_MS = 2 * 60 * 1000;

const PHASE_LABELS = {
  to_kitchen: 'Heading to the kitchen',
  to_customer: 'On the way to you',
};

/**
 * Live delivery tracking: where the delivery worker is, the road route to
 * where they're going (the kitchen first, then the customer) and how long is
 * left. The customer sees it on their tracking map from the moment a worker
 * accepts; the worker gets the same route with turn-by-turn steps.
 */
class DeliveryTrackingService {
  // deliveryId -> { phase, route, at }: one route shared by both viewers.
  #routes = new Map();

  /** GET /orders/:order_id/live — the customer's live map. */
  async customerLive(customerId, orderId) {
    const id = parseObjectId(orderId, 'order_id');
    const order = await orderRepository.findByCustomerAndId(customerId, id);
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    if (order.fulfillment === 'pickup') return { active: false, reason: 'pickup' };

    const delivery = await deliveryRepository.findByOrderId(order._id);
    const phase = this.#phase(delivery);
    if (!delivery?.driver_id || !phase) {
      return {
        active: false,
        reason: delivery?.status === 'completed' || order.status === 'delivered' ? 'delivered' : 'no_driver',
      };
    }
    return this.#view(delivery, { withSteps: false });
  }

  /** GET /driver/deliveries/:delivery_id/navigation — the worker's GPS view. */
  async driverNavigation(driver, deliveryId) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const delivery = await deliveryRepository.findByDriverAndId(driver._id, id);
    if (!delivery) throw ApiError.notFound('Delivery not found for this delivery worker.', 'DELIVERY_NOT_FOUND');
    if (!this.#phase(delivery)) return { active: false, reason: 'finished' };
    return this.#view(delivery, { withSteps: true });
  }

  /** Admin: the same live view (rider, route, ETA) for any delivery. */
  async adminView(delivery) {
    if (!delivery?.driver_id || !this.#phase(delivery)) return { active: false };
    return this.#view(delivery, { withSteps: false });
  }

  #phase(delivery) {
    if (!delivery) return null;
    if (delivery.status === 'assigned_to_driver') return 'to_kitchen';
    if (['picked_up', 'out_for_delivery'].includes(delivery.status)) return 'to_customer';
    return null;
  }

  async #view(delivery, { withSteps }) {
    const phase = this.#phase(delivery);
    const [driver, vendor] = await Promise.all([
      driverRepository.findById(delivery.driver_id),
      vendorRepository.findById(delivery.vendor_id),
    ]);

    const kitchen = {
      name: vendor?.name || null,
      address: delivery.pickup_location?.address || null,
      latitude: delivery.pickup_location?.latitude,
      longitude: delivery.pickup_location?.longitude,
    };
    const destination = {
      address: delivery.delivery_location?.address || null,
      neighborhood: delivery.delivery_location?.neighborhood || null,
      note: delivery.delivery_location?.note || null,
      latitude: delivery.delivery_location?.latitude,
      longitude: delivery.delivery_location?.longitude,
    };
    const target = phase === 'to_kitchen' ? kitchen : destination;

    const [lng, lat] = driver?.location?.coordinates ?? [];
    const hasFix = Number.isFinite(lat) && Number.isFinite(lng) && driver?.location_updated_at;
    const updatedAt = hasFix ? new Date(driver.location_updated_at) : null;
    const location = hasFix
      ? {
          latitude: lat,
          longitude: lng,
          heading: driver.location_heading ?? null,
          speed_mps: driver.location_speed_mps ?? null,
          accuracy_m: driver.location_accuracy_m ?? null,
          updated_at: updatedAt,
          stale: Date.now() - updatedAt.getTime() > STALE_LOCATION_MS,
        }
      : null;

    let route = null;
    if (location) {
      const here = [lng, lat];
      const full = await this.#routeFor(delivery, phase, here, target);
      const where = locateOnRoute(here, full.geometry);
      const share = where.totalM > 0 ? where.remainingM / where.totalM : 1;
      const remainingS = Math.round(full.duration_s * share);
      route = {
        source: full.source,
        geometry: full.geometry,
        distance_m: Math.round(where.remainingM + Math.min(where.offRouteM, OFF_ROUTE_M)),
        duration_s: remainingS,
        eta_at: new Date(Date.now() + remainingS * 1000),
        ...(withSteps ? { steps: full.steps } : {}),
      };
    }

    return {
      active: true,
      delivery_id: String(delivery._id),
      order_id: String(delivery.order_id),
      order_number: delivery.order_number,
      status: delivery.status,
      phase,
      phase_label: PHASE_LABELS[phase],
      kitchen_ready: isKitchenReady(delivery),
      driver: driver
        ? {
            name: driver.name,
            phone: driver.phone || null,
            vehicle_type: driver.vehicle_type || null,
            plate_number: driver.plate_number || null,
            rating: driver.rating ?? null,
            avatar_url: driver.profile_image_url || null,
            location,
          }
        : null,
      kitchen,
      destination,
      target: phase === 'to_kitchen' ? 'kitchen' : 'customer',
      route,
      refresh_after_s: 4,
    };
  }

  /** The cached road route for this leg, recomputed when it no longer fits. */
  async #routeFor(delivery, phase, here, target) {
    const key = String(delivery._id);
    const cached = this.#routes.get(key);
    const fits =
      cached &&
      cached.phase === phase &&
      Date.now() - cached.at < ROUTE_MAX_AGE_MS &&
      locateOnRoute(here, cached.route.geometry).offRouteM <= OFF_ROUTE_M;
    if (fits) return cached.route;

    const route = await routeNavigationService.route(
      { lat: here[1], lng: here[0] },
      { lat: target.latitude, lng: target.longitude }
    );
    this.#routes.set(key, { phase, route, at: Date.now() });
    if (this.#routes.size > 1000) this.#routes.delete(this.#routes.keys().next().value);
    return route;
  }
}

module.exports = new DeliveryTrackingService();

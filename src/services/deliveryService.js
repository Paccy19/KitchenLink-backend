const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const parsePagination = require('../utils/pagination');
const { haversineKm } = require('../utils/geo');
const { parseObjectId } = require('../utils/vendorValidators');
const {
  parseCoords,
  parseBoolean,
  parseDriverStatus,
  parseOtpCode,
  assertTransition,
} = require('../utils/deliveryValidators');
const { resolveImageUrl } = require('../utils/uploads');
const { serializeDelivery, serializeDriverAccount } = require('../utils/serializers');
const deliveryRepository = require('../repositories/deliveryRepository');
const driverRepository = require('../repositories/driverRepository');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const customerRepository = require('../repositories/customerRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const notificationService = require('./notificationService');

const { delivery: deliveryConfig } = config;

class DeliveryService {
  /* ============================ creation ============================= */

  /**
   * Creates the delivery leg for an order that is ready for pickup.
   * Idempotent: an order only ever has one delivery.
   */
  async ensureDeliveryForOrder(order, { vendor } = {}) {
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');

    const existing = await deliveryRepository.findByOrderId(order._id);
    if (existing) return existing;

    const vendorDoc =
      vendor || (await vendorRepository.findById(order.vendor_id)) || null;
    const pickup = {
      address: vendorDoc?.address || 'Vendor pickup point',
      neighborhood: vendorDoc?.neighborhood || '',
      latitude: vendorDoc?.location?.coordinates?.[1] ?? order.delivery_location.latitude,
      longitude: vendorDoc?.location?.coordinates?.[0] ?? order.delivery_location.longitude,
    };

    const distanceKm = this.#routeDistance(vendorDoc, order.delivery_location);
    const { fee, earnings } = this.#computeFees(distanceKm, order.delivery_fee_rwf);

    const delivery = await deliveryRepository.create({
      order_id: order._id,
      order_number: order.order_number,
      vendor_id: order.vendor_id,
      customer_id: order.customer_id,
      pickup_location: pickup,
      delivery_location: {
        address: order.delivery_location.address,
        neighborhood: order.delivery_location.neighborhood || '',
        note: order.delivery_location.note || '',
        latitude: order.delivery_location.latitude,
        longitude: order.delivery_location.longitude,
      },
      route_distance_km: distanceKm,
      delivery_fee_rwf: fee,
      promised_earnings_rwf: earnings,
      payment_method: order.payment_method,
      status: 'ready_for_pickup',
      otp_code: String(crypto.randomInt(100000, 1000000)),
      status_history: [
        {
          status: 'ready_for_pickup',
          at: new Date(),
          note: 'Food ready at vendor — awaiting driver',
          by: 'vendor',
        },
      ],
    });

    await orderRepository.update(order._id, {
      delivery_id: delivery._id,
      status: 'ready',
    });

    // Send the proof-of-delivery code to the customer (in-app + SMS).
    await this.#notifyCustomerDeliveryCode(order, delivery);

    const isDev = config.env !== 'production';
    if (isDev) {
      console.log(
        `[delivery] order ${order.order_number} prepared (otp ${delivery.otp_code}, ${distanceKm}km, ${fee} RWF)`
      );
    }

    return delivery;
  }

  /** Called by the vendor order flow when an order becomes "ready". */
  async handleOrderReady(order) {
    const delivery = await this.ensureDeliveryForOrder(order);
    const dispatchResult = await this.dispatch({
      deliveryId: delivery._id,
      orderId: order._id,
    });
    return { delivery: dispatchResult.delivery, notified: dispatchResult.notified };
  }

  /* ============================ dispatch ============================= */

  /**
   * Matching & broadcast. Finds online drivers near the pickup point, ranks
   * them (proximity → load → rating) and opens an offer window on each.
   * The first driver to accept atomically locks the assignment.
   */
  async dispatch({ orderId, deliveryId, force = false } = {}) {
    const delivery = deliveryId
      ? await deliveryRepository.findById(deliveryId)
      : await deliveryRepository.findByOrderId(orderId);
    if (!delivery) {
      throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');
    }
    if (delivery.driver_id) {
      return { delivery: await this.#serialize(delivery._id), notified: [] };
    }
    if (!deliveryConfig.dispatchableStatuses.includes(delivery.status)) {
      return { delivery: await this.#serialize(delivery._id), notified: [] };
    }

    const pickup = {
      lat: delivery.pickup_location.latitude,
      lng: delivery.pickup_location.longitude,
    };

    let candidates = [];
    try {
      candidates = await driverRepository.findNearbyAvailable({
        coords: pickup,
        radiusKm: deliveryConfig.defaultRadiusKm,
        excludeDriverIds: (delivery.rejected_by || []).map(String),
        limit: 20,
      });
    } catch (error) {
      candidates = [];
    }

    const eligible = candidates
      .filter(
        (driver) =>
          (driver.active_deliveries_count ?? 0) <
          (driver.max_active_deliveries || deliveryConfig.maxActiveDeliveries)
      )
      .slice(0, 10);

    const now = Date.now();
    const offeredAt = new Date(now);
    const expiresAt = new Date(now + deliveryConfig.offerTimeoutSeconds * 1000);

    if (eligible.length === 0) {
      await deliveryRepository.setOffers(delivery._id, {
        offers: [],
        broadcastCount: (delivery.dispatch?.broadcast_count || 0) + 1,
        lastBroadcastAt: offeredAt,
        offerExpiresAt: expiresAt,
      });
      return {
        delivery: await this.#serialize(delivery._id),
        notified: [],
        message: 'No available drivers found within range.',
      };
    }

    const offers = eligible.map((driver) => ({
      driver_id: driver._id,
      offered_at: offeredAt,
      expires_at: expiresAt,
      response: 'offered',
    }));

    await deliveryRepository.setOffers(delivery._id, {
      offers,
      broadcastCount: (delivery.dispatch?.broadcast_count || 0) + 1,
      lastBroadcastAt: offeredAt,
      offerExpiresAt: expiresAt,
    });

    // Push an in-app (+ SMS) notification to each nearby eligible driver so
    // they are alerted the moment the vendor marks the order ready.
    const vendorDoc = await vendorRepository.findById(delivery.vendor_id);
    await Promise.all(
      eligible.map((driver) =>
        notificationService
          .notifyDriverOffer(driver._id, {
            vendorName: vendorDoc?.name,
            orderNumber: delivery.order_number,
            pickupNeighborhood: delivery.pickup_location?.neighborhood,
            earningsRwf: delivery.promised_earnings_rwf || 0,
            orderId: delivery.order_id,
            deliveryId: delivery._id,
            expiresAt,
          })
          .catch(() => null)
      )
    );

    const notified = eligible.map((driver) => String(driver._id));
    if (config.env !== 'production') {
      console.log(
        `[delivery] broadcast ${delivery.order_number} → ${notified.length} driver(s): ${notified.join(', ')}`
      );
    }

    return { delivery: await this.#serialize(delivery._id), notified };
  }

  /**
   * Re-broadcasts unassigned deliveries whose offer window expired.
   * Safe to call repeatedly; used by the internal dispatch endpoint.
   */
  async expireStaleOffers() {
    const stale = await deliveryRepository.findStaleUnassigned(
      deliveryConfig.dispatchableStatuses,
      new Date()
    );
    const results = [];
    for (const delivery of stale) {
      const result = await this.dispatch({ deliveryId: delivery._id, force: true });
      results.push({ delivery_id: String(delivery._id), notified: result.notified });
    }
    return { re_dispatched: results.length, results };
  }

  /* ============================ driver reads ========================= */

  async listAvailable(driver, query = {}) {
    const coords =
      parseCoords(
        { latitude: query.lat, longitude: query.lng },
        { field: 'location', required: false }
      ) || this.#driverCoords(driver);

    const radiusKm = this.#parseRadius(query.radius);

    const raw = await deliveryRepository.listAvailable({
      statuses: deliveryConfig.availableStatuses,
    });

    const items = raw
      .filter((delivery) => !(delivery.rejected_by || []).some((id) => String(id) === String(driver._id)))
      .map((delivery) => {
        const distance = coords
          ? haversineKm(
              coords.lat,
              coords.lng,
              delivery.pickup_location.latitude,
              delivery.pickup_location.longitude
            )
          : null;
        return { delivery, distance };
      })
      .filter((entry) => (coords ? entry.distance <= radiusKm : true))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

    const orders = await this.#loadOrders(items.map((entry) => entry.delivery));

    return {
      deliveries: await Promise.all(
        items.map((entry) => this.#serialize(entry.delivery, { order: orders.get(String(entry.delivery.order_id)) }, { distanceFromDriverKm: entry.distance, revealCustomer: false }))
      ),
      meta: {
        radius_km: radiusKm,
        count: items.length,
        driver_online: Boolean(driver.is_online),
      },
    };
  }

  async getActive(driver) {
    const delivery = await deliveryRepository.findActiveByDriver(
      driver._id,
      deliveryConfig.activeStatuses
    );
    if (!delivery) return { delivery: null };
    const order = await orderRepository.findById(delivery.order_id);
    return {
      delivery: await this.#serialize(delivery, { order }),
    };
  }

  async history(driver, query = {}) {
    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: config.limits.ordersDefault,
      maxLimit: config.limits.ordersMax,
    });
    const { deliveries, total } = await deliveryRepository.listByDriver(driver._id, {
      statuses: deliveryConfig.terminalStatuses,
      limit,
      offset,
    });
    const orders = await this.#loadOrders(deliveries);
    return {
      deliveries: await Promise.all(
        deliveries.map((delivery) =>
          this.#serialize(delivery, { order: orders.get(String(delivery.order_id)) })
        )
      ),
      meta: { limit, page, offset, total },
    };
  }

  async stats(driver) {
    const { start, end } = this.#todayWindow();
    const stats = await deliveryRepository.aggregateDriverStats(driver._id, { start, end });
    const fresh = await driverRepository.findById(driver._id);
    return {
      active_deliveries: fresh?.active_deliveries_count ?? 0,
      completed_today: stats.today.count,
      earnings_today_rwf: stats.today.earnings,
      completed_total: stats.total.count,
      earnings_total_rwf: stats.total.earnings,
      rating: fresh?.rating ?? 5,
      is_online: Boolean(fresh?.is_online),
      status: fresh?.status || 'offline',
    };
  }

  async earnings(driver, query = {}) {
    const { start, end } = this.#todayWindow();
    const stats = await deliveryRepository.aggregateDriverStats(driver._id, { start, end });
    const fresh = await driverRepository.findById(driver._id);
    const historyResult = await this.history(driver, { ...query, limit: query.limit || 20 });
    return {
      today_rwf: stats.today.earnings,
      today_deliveries: stats.today.count,
      total_rwf: stats.total.earnings,
      total_deliveries: stats.total.count,
      share_percent: deliveryConfig.driverSharePercent,
      rating: fresh?.rating ?? 5,
      deliveries: historyResult.deliveries,
      meta: historyResult.meta,
    };
  }

  /* ============================ driver actions ======================= */

  async accept(driver, deliveryId) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const now = new Date();

    const delivery = await deliveryRepository.claim(driver._id, id, {
      status: 'assigned_to_driver',
      assignedAt: now,
    });

    if (!delivery) {
      const current = await deliveryRepository.findById(id);
      if (!current) {
        throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');
      }
      if (current.driver_id) {
        throw ApiError.conflict(
          'This delivery has already been accepted by another driver.',
          'DELIVERY_ALREADY_ASSIGNED'
        );
      }
      throw ApiError.conflict(
        'This delivery is no longer available.',
        'DELIVERY_NOT_AVAILABLE'
      );
    }

    const fresh = await driverRepository.incrementActive(driver._id);
    const activeCount = fresh?.active_deliveries_count ?? 1;
    if (activeCount >= (fresh?.max_active_deliveries || deliveryConfig.maxActiveDeliveries)) {
      await driverRepository.setAvailability(driver._id, { status: 'busy' });
    }

    await orderRepository.update(delivery.order_id, {
      driver_id: driver._id,
      delivery_id: delivery._id,
      rider: { name: driver.name, phone: driver.phone },
      status: 'assigned',
    });
    await orderRepository.pushHistory(delivery.order_id, {
      status: 'assigned',
      at: now,
      note: `Driver ${driver.name} assigned`,
    });

    return {
      delivery: await this.#serialize(delivery._id, {}, { revealCustomer: true }),
      driver: serializeDriverAccount(fresh || driver),
    };
  }

  async reject(driver, deliveryId) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const delivery = await deliveryRepository.findById(id);
    if (!delivery) {
      throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');
    }
    if (delivery.driver_id && String(delivery.driver_id) !== String(driver._id)) {
      throw ApiError.conflict(
        'This delivery has already been accepted.',
        'DELIVERY_ALREADY_ASSIGNED'
      );
    }

    await deliveryRepository.addRejection(id, driver._id);
    const updated = await deliveryRepository.findById(id);
    updated.dispatch = updated.dispatch || {};
    const offers = (updated.dispatch.offers || []).map((offer) =>
      String(offer.driver_id) === String(driver._id)
        ? { ...offer, response: 'rejected', responded_at: new Date() }
        : offer
    );
    await deliveryRepository.setOffers(id, {
      offers,
      broadcastCount: updated.dispatch.broadcast_count || 0,
      lastBroadcastAt: updated.dispatch.last_broadcast_at,
      offerExpiresAt: updated.dispatch.offer_expires_at,
    });

    // Re-broadcast to the next eligible drivers (excluding this one).
    await this.dispatch({ deliveryId: id, force: true });

    return { rejected: true, delivery_id: String(id) };
  }

  async updateStatus(driver, deliveryId, body = {}) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const nextStatus = parseDriverStatus(body?.status);

    const delivery = await deliveryRepository.findByDriverAndId(driver._id, id);
    if (!delivery) {
      throw ApiError.notFound('Delivery not found for this driver.', 'DELIVERY_NOT_FOUND');
    }

    assertTransition(delivery.status, nextStatus);

    const now = new Date();
    const update = { status: nextStatus };
    if (nextStatus === 'picked_up') update.picked_up_at = now;
    if (nextStatus === 'out_for_delivery') update.out_for_delivery_at = now;
    if (nextStatus === 'delivered') update.delivered_at = now;

    const updated = await deliveryRepository.update(id, update);
    await deliveryRepository.pushHistory(id, {
      status: nextStatus,
      at: now,
      note: deliveryConfig.statusLabels[nextStatus],
      by: 'driver',
    });

    // Side-effects on the order lifecycle.
    if (nextStatus === 'picked_up') {
      await orderRepository.update(delivery.order_id, {
        status: 'picked_up',
        picked_up_at: now,
      });
      await orderRepository.pushHistory(delivery.order_id, {
        status: 'picked_up',
        at: now,
        note: 'Picked up by rider',
      });
    }
    if (nextStatus === 'out_for_delivery') {
      await orderRepository.update(delivery.order_id, { status: 'out_for_delivery' });
      await orderRepository.pushHistory(delivery.order_id, {
        status: 'out_for_delivery',
        at: now,
        note: 'Out for delivery',
      });
      // Remind the customer of the confirmation code as the rider heads over.
      await this.#notifyCustomerDeliveryCode(delivery, delivery, { reminder: true });
    }
    if (nextStatus === 'delivered') {
      await this.#settleOrderDelivered(delivery);
    }

    return {
      delivery: await this.#serialize(updated._id, {}, { revealCustomer: true }),
    };
  }

  async confirmDelivery(driver, deliveryId, body = {}) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const delivery = await deliveryRepository.findByDriverAndId(driver._id, id);
    if (!delivery) {
      throw ApiError.notFound('Delivery not found for this driver.', 'DELIVERY_NOT_FOUND');
    }
    if (['completed', 'cancelled', 'rejected'].includes(delivery.status)) {
      throw ApiError.conflict(
        'This delivery is already closed.',
        'DELIVERY_ALREADY_CLOSED'
      );
    }
    if (!['out_for_delivery', 'delivered'].includes(delivery.status)) {
      throw ApiError.conflict(
        'Start the delivery before confirming it.',
        'DELIVERY_NOT_OUT_FOR_DELIVERY'
      );
    }

    const code = parseOtpCode(body?.otp_code);
    if (delivery.otp_code && code !== delivery.otp_code) {
      throw ApiError.badRequest('Incorrect delivery code.', 'OTP_INVALID', {
        otp_code: 'incorrect code',
      });
    }

    const proofPhotoUrl =
      resolveImageUrl({
        file: body?.file,
        image_url: body?.proof_photo_url,
        image_base64: body?.proof_photo_base64,
      }) || undefined;

    const now = new Date();
    const updated = await deliveryRepository.update(id, {
      status: 'completed',
      completed_at: now,
      otp_verified_at: now,
      ...(proofPhotoUrl ? { proof_photo_url: proofPhotoUrl } : {}),
    });
    await deliveryRepository.pushHistory(id, {
      status: 'completed',
      at: now,
      note: 'Proof of delivery confirmed',
      by: 'driver',
    });

    await this.#settleOrderDelivered(delivery, { completed: true });

    const fresh = await driverRepository.recordCompletion(driver._id, {
      earningsRwf: delivery.promised_earnings_rwf || 0,
    });
    const active = fresh?.active_deliveries_count ?? 0;
    if (!fresh?.is_online) {
      await driverRepository.setAvailability(driver._id, { status: 'offline' });
    } else if (active <= 0) {
      await driverRepository.setAvailability(driver._id, { status: 'online' });
    } else {
      await driverRepository.setAvailability(driver._id, { status: 'busy' });
    }

    return {
      delivery: await this.#serialize(updated._id, {}, { revealCustomer: true }),
      earned_rwf: delivery.promised_earnings_rwf || 0,
      driver: serializeDriverAccount(fresh || driver),
    };
  }

  async updateLocation(driver, body = {}) {
    const coords = parseCoords(body, { field: 'location', required: true });
    const updated = await driverRepository.setLocation(driver._id, coords);
    return {
      current_location: {
        latitude: coords.lat,
        longitude: coords.lng,
        updated_at: updated?.location_updated_at || new Date(),
      },
    };
  }

  async setAvailability(driver, body = {}) {
    const isOnline = parseBoolean(body?.is_online, {
      field: 'is_online',
      fallback: !driver.is_online,
    });

    const fresh = await driverRepository.setAvailability(driver._id, {
      isOnline,
      status: isOnline
        ? (driver.active_deliveries_count ?? 0) > 0
          ? 'busy'
          : 'online'
        : 'offline',
    });

    let reassigned = 0;
    if (!isOnline) {
      reassigned = await this.reassignDriverDeliveries(driver._id);
    }

    return {
      driver: serializeDriverAccount(fresh || { ...driver, is_online: isOnline }),
      reassigned_deliveries: reassigned,
    };
  }

  /**
   * Edge case: a driver that goes offline (or is deactivated) after accepting
   * has their in-flight deliveries returned to the pool and re-broadcast.
   */
  async reassignDriverDeliveries(driverId) {
    const deliveries = await deliveryRepository.findAssignedToDriver(
      driverId,
      deliveryConfig.activeStatuses
    );
    for (const delivery of deliveries) {
      await deliveryRepository.update(delivery._id, {
        driver_id: null,
        status: 'ready_for_pickup',
        assigned_at: null,
      });
      await deliveryRepository.pushHistory(delivery._id, {
        status: 'ready_for_pickup',
        at: new Date(),
        note: 'Driver went offline — re-broadcast',
        by: 'system',
      });
      await deliveryRepository.addRejection(delivery._id, driverId);
      await this.dispatch({ deliveryId: delivery._id, force: true });
    }
    if (deliveries.length > 0) {
      await driverRepository.update(driverId, { active_deliveries_count: 0 });
    }
    return deliveries.length;
  }

  /* ============================ helpers ============================== */

  /**
   * Shares the delivery confirmation code with the customer over the in-app
   * notification channel (and SMS mirror). Best-effort: a notification failure
   * must never roll back the delivery itself.
   */
  async #notifyCustomerDeliveryCode(order, delivery, { reminder = false } = {}) {
    const customerId = order?.customer_id || delivery?.customer_id;
    const code = delivery?.otp_code;
    if (!customerId || !code) return;
    try {
      await notificationService.notifyDeliveryCode(customerId, {
        orderNumber: order?.order_number || delivery?.order_number,
        orderId: order?._id || delivery?._id,
        code,
        reminder,
      });
    } catch (error) {
      console.log(`[delivery] could not notify customer of delivery code: ${error?.message}`);
    }
  }

  async #settleOrderDelivered(delivery, { completed = false } = {}) {
    const order = await orderRepository.findById(delivery.order_id);
    if (!order) return;

    const now = new Date();
    const update = {
      status: 'delivered',
      delivered_at: now,
      ...(completed ? { completed_at: now } : {}),
    };

    await orderRepository.update(delivery.order_id, update);
    await orderRepository.pushHistory(delivery.order_id, {
      status: completed ? 'delivered' : 'delivered',
      at: now,
      note: completed ? 'Delivered and confirmed' : 'Delivered',
    });

    // Full completion only happens when the OTP was verified. This mirrors what
    // the vendor's manual "mark completed" did, so the kitchen never has to come
    // back: the vendor is credited and dish counts bump.
    if (completed) {
      await this.#applyVendorCompletion(order, delivery);
    }
  }

  /**
   * Vendor-side completion side-effects, credited exactly once per order (the
   * delivery is terminal after OTP confirmation, so it can never re-run).
   */
  async #applyVendorCompletion(order, delivery) {
    const vendorId = order.vendor_id || delivery.vendor_id;
    if (!vendorId) return;
    try {
      const commission = config.vendor.commissionPercent / 100;
      const balanceRwf = Math.round(order.total_rwf * (1 - commission));
      await vendorRepository.incrementSales(vendorId, {
        totalRwf: order.total_rwf,
        balanceRwf,
      });

      await Promise.all(
        (order.items || []).map((item) =>
          menuItemRepository.incrementOrdersCount(item.menu_item_id, item.quantity)
        )
      );
    } catch (error) {
      console.log(`[delivery] vendor completion side-effects failed: ${error?.message}`);
    }
  }

  #driverCoords(driver) {
    const coordinates = driver?.location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  #parseRadius(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return deliveryConfig.defaultRadiusKm;
    return Math.min(value, config.geo.maxRadiusKm);
  }

  #routeDistance(vendor, deliveryLocation) {
    const coordinates = vendor?.location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
    const straight = haversineKm(
      lat,
      lng,
      deliveryLocation.latitude,
      deliveryLocation.longitude
    );
    return Math.round(straight * deliveryConfig.roadFactor * 10) / 10;
  }

  #computeFees(distanceKm, fallbackFee) {
    const { baseFeeRwf, perKmFeeRwf, minFeeRwf, driverSharePercent } = deliveryConfig;
    const computed = Math.max(
      minFeeRwf,
      Math.round(baseFeeRwf + perKmFeeRwf * (distanceKm || 0))
    );
    const fee = Number(fallbackFee) > 0 ? Number(fallbackFee) : computed;
    const earnings = Math.round(fee * (driverSharePercent / 100));
    return { fee, earnings, computed };
  }

  #todayWindow() {
    const offsetMs = config.vendor.timezoneOffsetHours * 60 * 60 * 1000;
    const nowShifted = new Date(Date.now() + offsetMs);
    const startShifted = Date.UTC(
      nowShifted.getUTCFullYear(),
      nowShifted.getUTCMonth(),
      nowShifted.getUTCDate()
    );
    const start = new Date(startShifted - offsetMs);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  async #loadOrders(deliveries) {
    const ids = [...new Set(deliveries.map((delivery) => String(delivery.order_id)))];
    const orders = await Promise.all(ids.map((id) => orderRepository.findById(id)));
    return new Map(
      orders.filter(Boolean).map((order) => [String(order._id), order])
    );
  }

  async #serialize(deliveryId, { order } = {}, options = {}) {
    const delivery = await deliveryRepository.findByIdPopulated(deliveryId);
    if (!delivery) throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');

    const orderDoc = order || (await orderRepository.findById(delivery.order_id));

    const serialized = serializeDelivery(delivery, {
      order: orderDoc,
      driver: delivery.driver_id,
      ...options,
    });

    // Development convenience: surface the pickup OTP so the flow is testable.
    if (config.env !== 'production' && delivery.otp_code) {
      serialized.dev_otp = delivery.otp_code;
    }
    return serialized;
  }
}

module.exports = new DeliveryService();

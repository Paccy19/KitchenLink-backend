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
const { isKitchenReady } = require('../utils/deliveryReady');
const deliveryRepository = require('../repositories/deliveryRepository');
const { Delivery } = require('../models');
const driverRepository = require('../repositories/driverRepository');
const orderRepository = require('../repositories/orderRepository');
const vendorRepository = require('../repositories/vendorRepository');
const customerRepository = require('../repositories/customerRepository');
const notificationService = require('./notificationService');
const settlementService = require('./settlementService');
const deliveryPricingService = require('./deliveryPricingService');
const orderNotifications = require('./orderNotifications');
const deliverySettingsService = require('./deliverySettingsService');
const dispatchSettingsService = require('./dispatchSettingsService');
const { usesHandoverCode } = require('../utils/fulfillment');

// Admin-set dispatch rules in force right now (Settings → Delivery & pickup rules).
const dispatchRules = () => dispatchSettingsService.current();

// A delivery with no pickup clock running.
const NO_CLOCK = { pickup_started_at: null, pickup_warn_at: null, pickup_due_at: null, pickup_reassign_at: null };

/** A time of day in Kigali, e.g. "12:15". */
const kigaliTime = (date) =>
  new Date(date).toLocaleTimeString('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit' });

/**
 * The admin's timing rules in words, for workers' messages. Late pickups are
 * not charged: a worker who is too late only loses the order to someone else.
 */
const timingText = () => {
  const rules = deliverySettingsService.current();
  return `Collect it within ${rules.charge_after_minutes} minutes of the food being ready${
    rules.reassign_after_minutes ? `; after ${rules.reassign_after_minutes} minutes it goes to another delivery worker` : ''
  }.`;
};

// Late pickups are recorded for support but never charged.
const LATE_NOT_CHARGED = 'waived';

const { delivery: deliveryConfig } = config;

class DeliveryService {
  /* ============================ creation ============================= */

  /**
   * Creates the delivery leg for an order: at placement for immediate orders
   * (`ready: false`, the kitchen is still cooking) or when the food is ready.
   * Idempotent: an order only ever has one delivery.
   */
  async ensureDeliveryForOrder(order, { vendor, ready = true } = {}) {
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

    // Prefer the distance the customer was charged for; older orders predate it.
    const distanceKm =
      order.delivery_distance_km ?? this.#routeDistance(vendorDoc, order.delivery_location);
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
      status: ready ? 'ready_for_pickup' : 'pending',
      ready_at: ready ? new Date() : null,
      otp_code: String(crypto.randomInt(100000, 1000000)),
      status_history: [
        ready
          ? {
              status: 'ready_for_pickup',
              at: new Date(),
              note: 'Food ready at vendor — awaiting a delivery worker',
              by: 'vendor',
            }
          : {
              status: 'pending',
              at: new Date(),
              note: 'Order placed — offered to nearby delivery workers while the kitchen prepares it',
              by: 'system',
            },
      ],
    });

    await orderRepository.update(order._id, {
      delivery_id: delivery._id,
      ...(ready ? { status: 'ready' } : {}),
    });

    if (ready) {
      // Send the proof-of-delivery code to the customer (in-app + SMS).
      await this.#notifyCustomerDeliveryCode(order, delivery);
    }

    const isDev = config.explicitDev;
    if (isDev) {
      console.log(
        `[delivery] order ${order.order_number} ${ready ? 'ready' : 'placed'} (otp ${delivery.otp_code}, ${distanceKm}km, ${fee} RWF)`
      );
    }

    return delivery;
  }

  /**
   * Before a vendor or customer cancels an order: once the delivery worker
   * has collected the food it can no longer be cancelled (they complete it by
   * confirming the customer's code). A driver who accepted early, while the
   * kitchen was still cooking, is released instead.
   */
  async assertCancellable(orderId) {
    const delivery = await deliveryRepository.findByOrderId(orderId);
    if (!delivery) return;
    if (['picked_up', 'out_for_delivery', 'delivered', 'completed'].includes(delivery.status)) {
      throw ApiError.conflict(
        'A delivery worker is already delivering this order, so it can no longer be cancelled.',
        'DELIVERY_IN_PROGRESS'
      );
    }
  }

  /** After an order is cancelled: withdraw its offer and release any assigned driver. */
  async cancelOpenDelivery(orderId, note = 'Order cancelled') {
    const delivery = await deliveryRepository.findByOrderId(orderId);
    if (!delivery) return;
    const assigned = delivery.status === 'assigned_to_driver' && delivery.driver_id;
    if (!assigned && !deliveryConfig.availableStatuses.includes(delivery.status)) return;

    const now = new Date();
    await deliveryRepository.update(delivery._id, { status: 'cancelled', cancelled_at: now, cancel_reason: note });
    await deliveryRepository.pushHistory(delivery._id, { status: 'cancelled', at: now, note, by: 'system' });

    if (assigned) {
      await this.#releaseDriver(delivery.driver_id);
      notificationService
        .notifyDriver(delivery.driver_id, {
          type: 'delivery_cancelled',
          title: 'Order cancelled',
          body: `${delivery.order_number} was cancelled (${note}). You don't need to collect it.`,
          orderId: delivery.order_id,
          data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
          sms: true,
        })
        .catch(() => null);
    }
  }

  /**
   * Called when an immediate order is paid, i.e. the moment the kitchen is
   * told about it: the delivery is created and offered to nearby drivers
   * right away so one can head to the kitchen while the food is cooked.
   * Scheduled orders and pre-orders are offered when the kitchen marks them
   * ready instead, since they may be due hours or days later.
   */
  async handleOrderPlaced(order) {
    if (!order || usesHandoverCode(order)) return null; // collected, or the kitchen brings it
    if (order.order_type && order.order_type !== 'immediate') return null;
    const delivery = await this.ensureDeliveryForOrder(order, { ready: false });
    return this.dispatch({ deliveryId: delivery._id });
  }

  /** Called by the vendor order flow when an order becomes "ready". */
  async handleOrderReady(order) {
    // Pickup and kitchen-delivered orders never get a delivery worker.
    if (usesHandoverCode(order)) return { delivery: null, notified: [] };
    const existing = await deliveryRepository.findByOrderId(order._id);
    if (!existing) {
      const delivery = await this.ensureDeliveryForOrder(order, { ready: true });
      const result = await this.dispatch({ deliveryId: delivery._id });
      return { delivery: result.delivery, notified: result.notified };
    }
    if (['cancelled', 'rejected'].includes(existing.status) || isKitchenReady(existing)) {
      return { delivery: await this.#serialize(existing._id), notified: [] };
    }

    const now = new Date();
    await this.#notifyCustomerDeliveryCode(order, existing);

    if (existing.driver_id) {
      // A driver accepted while the food was cooking: their pickup clock starts.
      const clock = this.#pickupClock(now, existing.assigned_at);
      await deliveryRepository.update(existing._id, { ready_at: now, ...clock });
      await deliveryRepository.pushHistory(existing._id, {
        status: existing.status,
        at: now,
        note: 'Food ready at vendor — waiting for the assigned delivery worker',
        by: 'vendor',
      });
      await orderRepository.update(order._id, { status: 'assigned' });
      await notificationService
        .notifyDriver(existing.driver_id, {
          type: 'delivery_ready',
          title: 'Food is ready — collect it now',
          body: `${existing.order_number} is ready at the kitchen. ${timingText()}`,
          orderId: existing.order_id,
          link: '/driver-dashboard/active',
          data: { delivery_id: String(existing._id), order_number: existing.order_number, pickup_due_at: clock.pickup_due_at?.toISOString() ?? null },
          sms: true,
        })
        .catch(() => null);
      return { delivery: await this.#serialize(existing._id), notified: [String(existing.driver_id)] };
    }

    // Nobody accepted yet: the offer now says "ready", and drivers who came
    // into range since placement are added.
    await deliveryRepository.update(existing._id, { status: 'ready_for_pickup', ready_at: now });
    await deliveryRepository.pushHistory(existing._id, {
      status: 'ready_for_pickup',
      at: now,
      note: 'Food ready at vendor — awaiting a delivery worker',
      by: 'vendor',
    });
    const result = await this.dispatch({ deliveryId: existing._id });
    return { delivery: result.delivery, notified: result.notified };
  }

  /* ============================ dispatch ============================= */

  /**
   * Matching & broadcast. Every online driver within the dispatch radius of
   * the kitchen (with a recent position and room for another delivery) is
   * offered the order. Repeat calls add drivers who came online or into
   * range since; drivers already offered are not notified again. The first
   * driver to accept atomically locks the assignment.
   */
  async dispatch({ orderId, deliveryId } = {}) {
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

    const previousOffers = delivery.dispatch?.offers || [];
    const alreadyOffered = new Set(previousOffers.map((offer) => String(offer.driver_id)));

    let candidates = [];
    try {
      candidates = await driverRepository.findNearbyAvailable({
        coords: pickup,
        radiusKm: dispatchRules().radius_km,
        excludeDriverIds: [...(delivery.rejected_by || []).map(String), ...alreadyOffered],
        limit: dispatchRules().max_offer_recipients,
        locationSince: this.#locationCutoff(),
      });
    } catch (error) {
      console.log(`[delivery] driver matching failed: ${error.message}`);
      candidates = [];
    }

    const eligible = candidates.filter(
      (driver) => (driver.active_deliveries_count ?? 0) < dispatchRules().max_active_deliveries
    );

    const now = Date.now();
    const offeredAt = new Date(now);
    const expiresAt = new Date(now + deliveryConfig.offerTimeoutSeconds * 1000);

    await deliveryRepository.setOffers(delivery._id, {
      offers: [
        ...previousOffers,
        ...eligible.map((driver) => ({
          driver_id: driver._id,
          offered_at: offeredAt,
          expires_at: expiresAt,
          response: 'offered',
        })),
      ],
      broadcastCount: (delivery.dispatch?.broadcast_count || 0) + 1,
      lastBroadcastAt: offeredAt,
      offerExpiresAt: expiresAt,
    });

    if (eligible.length === 0) {
      return {
        delivery: await this.#serialize(delivery._id),
        notified: [],
        message: 'No new delivery workers found within range.',
      };
    }

    // Alert each newly matched driver (in-app + SMS) at the same moment the
    // kitchen is told about the order (or that it is ready).
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
            ready: isKitchenReady(delivery),
            distanceKm: driver.distance_km,
          })
          .catch(() => null)
      )
    );

    const notified = eligible.map((driver) => String(driver._id));
    if (config.env !== 'production') {
      console.log(
        `[delivery] broadcast ${delivery.order_number} → ${notified.length} delivery worker(s): ${notified.join(', ')}`
      );
    }

    return { delivery: await this.#serialize(delivery._id), notified };
  }

  /**
   * Re-broadcasts unassigned deliveries whose offer window expired, so
   * drivers who came online or into range since are offered them too.
   * Safe to call repeatedly; used by the dispatch tick and internal endpoint.
   */
  async expireStaleOffers() {
    const stale = await deliveryRepository.findStaleUnassigned(
      deliveryConfig.dispatchableStatuses,
      new Date()
    );
    const results = [];
    for (const delivery of stale) {
      const result = await this.dispatch({ deliveryId: delivery._id });
      results.push({ delivery_id: String(delivery._id), notified: result.notified });
    }
    return { re_dispatched: results.length, results };
  }

  /**
   * Pickup clock for assigned deliveries whose food is ready, using the times
   * fixed when each clock started (the admin's rules at that moment): a
   * reminder, then a late pickup with a pending charge, then — if the admin
   * set a reassign time — the order is taken away and offered to others.
   */
  async checkLatePickups(now = new Date()) {
    const rules = deliverySettingsService.current();
    const waiting = await deliveryRepository.findAwaitingPickup();
    let warned = 0;
    let flagged = 0;

    for (const delivery of waiting) {
      const dueAt = new Date(delivery.pickup_due_at);
      // Clocks started before the timing rules existed have no warn time.
      const warnAt = delivery.pickup_warn_at
        ? new Date(delivery.pickup_warn_at)
        : new Date(dueAt.getTime() - (rules.charge_after_minutes - rules.warning_minutes) * 60000);
      const minutesLeft = Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / 60000));
      const graceMinutes = delivery.pickup_started_at
        ? Math.round((dueAt - new Date(delivery.pickup_started_at)) / 60000)
        : rules.charge_after_minutes;

      if (now >= dueAt) {
        await deliveryRepository.update(delivery._id, {
          'late_pickup.flagged_at': now,
          'late_pickup.charge_status': LATE_NOT_CHARGED,
          'late_pickup.penalty_percent': null,
        });
        await deliveryRepository.pushHistory(delivery._id, {
          status: delivery.status,
          at: now,
          note: `Not collected by ${kigaliTime(dueAt)} (${graceMinutes} minutes) — late pickup recorded`,
          by: 'system',
        });
        const reassignNote = delivery.pickup_reassign_at
          ? ` If it isn't collected by ${kigaliTime(delivery.pickup_reassign_at)}, it will be given to another delivery worker.`
          : '';
        notificationService
          .notifyDriver(delivery.driver_id, {
            type: 'delivery_late',
            title: 'Late pickup',
            body: `${delivery.order_number} has been ready for over ${graceMinutes} minutes. Collect it now.${reassignNote}`,
            orderId: delivery.order_id,
            link: '/driver-dashboard/active',
            data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
            sms: true,
          })
          .catch(() => null);
        // Support can call a nearby worker and reassign the order.
        notificationService
          .notifyAdmin({
            type: 'late_pickup',
            title: 'Late pickup',
            body: `${delivery.order_number} has waited over ${graceMinutes} minutes at the kitchen and the delivery worker hasn't collected it. Call a nearby worker to take over${delivery.pickup_reassign_at ? ', or it will be re-offered automatically' : ''}.`,
            orderId: delivery.order_id,
            link: `/admin-dashboard/deliveries?tab=late`,
            data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
          })
          .catch(() => null);
        flagged += 1;
      } else if (!delivery.late_pickup?.warned_at && now >= warnAt) {
        await deliveryRepository.update(delivery._id, { 'late_pickup.warned_at': now });
        notificationService
          .notifyDriver(delivery.driver_id, {
            type: 'delivery_pickup_reminder',
            title: `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} left to collect`,
            body: `${delivery.order_number} is waiting at the kitchen. Collect it within ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}${
              delivery.pickup_reassign_at ? `, or it will be given to another delivery worker at ${kigaliTime(delivery.pickup_reassign_at)}` : ''
            }.`,
            orderId: delivery.order_id,
            link: '/driver-dashboard/active',
            data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
            sms: true,
          })
          .catch(() => null);
        warned += 1;
      }
    }

    // Still not collected at the reassign time: give the order to someone else.
    const overdue = await deliveryRepository.findDueForReassign(now);
    let reassigned = 0;
    for (const delivery of overdue) {
      if (await this.#autoReassign(delivery, now)) reassigned += 1;
    }
    return { warned, flagged, reassigned };
  }

  /**
   * Takes a late order away from its worker and offers it again to nearby
   * workers (never back to the late one). Their late record and pending
   * charge are kept; the kitchen, the customer and support are told.
   */
  async #autoReassign(delivery, now) {
    const driverId = delivery.driver_id;
    const released = await deliveryRepository.releaseIfStillAssigned(delivery._id, driverId, {
      status: 'ready_for_pickup',
      ...NO_CLOCK,
    });
    if (!released) return false; // collected or reassigned meanwhile

    const minutes = delivery.pickup_started_at
      ? Math.round((now - new Date(delivery.pickup_started_at)) / 60000)
      : null;
    await deliveryRepository.pushLateRecord(delivery._id, {
      driver_id: driverId,
      flagged_at: delivery.late_pickup?.flagged_at || now,
      minutes_late: delivery.pickup_due_at ? Math.ceil((now - new Date(delivery.pickup_due_at)) / 60000) : null,
      charge_status: LATE_NOT_CHARGED,
      penalty_percent: null,
      note: 'Order taken away and given to another delivery worker — no charge',
      reassigned_at: now,
    });
    await deliveryRepository.update(delivery._id, {
      'late_pickup.warned_at': null,
      'late_pickup.flagged_at': null,
      'late_pickup.minutes_late': null,
      'late_pickup.charge_status': 'none',
      'late_pickup.charge_rwf': null,
      'late_pickup.penalty_percent': null,
    });
    await deliveryRepository.addRejection(delivery._id, driverId);
    const driver = await driverRepository.findById(driverId);
    await deliveryRepository.pushHistory(delivery._id, {
      status: 'ready_for_pickup',
      at: now,
      note: `Not collected${minutes ? ` after ${minutes} minutes` : ''} — taken from ${driver?.name || 'the delivery worker'} and offered to other nearby delivery workers`,
      by: 'system',
    });
    await this.#releaseDriver(driverId);

    const order = await orderRepository.update(delivery.order_id, { driver_id: null, rider: null, status: 'ready' });
    await orderRepository.pushHistory(delivery.order_id, {
      status: 'ready',
      at: now,
      note: 'The delivery worker was too late — finding a new one',
    });

    notificationService
      .notifyDriver(driverId, {
        type: 'delivery_cancelled',
        title: 'Order taken away — too late',
        body: `${delivery.order_number} was given to another delivery worker because you didn't collect it${minutes ? ` within ${minutes} minutes` : ' in time'}. Don't go to the kitchen for it.`,
        orderId: delivery.order_id,
        data: { delivery_id: String(delivery._id), order_number: delivery.order_number, reason: 'late_pickup' },
        sms: true,
      })
      .catch(() => null);
    if (order) orderNotifications.findingNewWorker(order);
    notificationService
      .notifyAdmin({
        type: 'late_pickup',
        title: 'Late order re-offered',
        body: `${delivery.order_number} was taken from ${driver?.name || 'the delivery worker'} after ${minutes ?? 'too many'} minutes and offered to other nearby delivery workers.`,
        orderId: delivery.order_id,
        link: `/admin-dashboard/orders?order=${delivery.order_id}`,
        data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
      })
      .catch(() => null);

    // Everyone nearby (except the late worker) is offered it again.
    await deliveryRepository.setOffers(delivery._id, {
      offers: [],
      broadcastCount: delivery.dispatch?.broadcast_count || 0,
      lastBroadcastAt: delivery.dispatch?.last_broadcast_at,
      offerExpiresAt: null,
    });
    await this.dispatch({ deliveryId: delivery._id });
    return true;
  }

  #ticker = null;
  #ticking = false;

  /**
   * Runs re-broadcasts and pickup checks on an interval (in-process). The
   * interval is the admin's "re-offered every" rule; calling start() again
   * (after the rule changes) restarts it with the new value.
   */
  start() {
    if (this.#ticker) clearInterval(this.#ticker);
    const tick = async () => {
      if (this.#ticking) return;
      this.#ticking = true;
      try {
        await this.expireStaleOffers();
        await this.checkLatePickups();
      } catch (error) {
        console.error('[delivery] dispatch tick failed:', error.message);
      } finally {
        this.#ticking = false;
      }
    };
    this.#ticker = setInterval(tick, dispatchRules().rebroadcast_every_seconds * 1000);
    this.#ticker.unref?.();
    return this.#ticker;
  }

  /* ============================ driver reads ========================= */

  async listAvailable(driver, query = {}) {
    const coords =
      parseCoords(
        { latitude: query.lat, longitude: query.lng },
        { field: 'location', required: false }
      ) || this.#driverCoords(driver);

    // The board shows the orders this driver was offered (they were within
    // the dispatch radius) plus any open order within that radius of where
    // they are now, nearest first.
    const radiusKm = dispatchRules().radius_km;
    const driverId = String(driver._id);

    const raw = await deliveryRepository.listAvailable({
      statuses: deliveryConfig.availableStatuses,
    });

    const items = raw
      .filter((delivery) => !(delivery.rejected_by || []).some((id) => String(id) === driverId))
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
      .filter(
        (entry) =>
          this.#wasOffered(entry.delivery, driverId) || (entry.distance != null && entry.distance <= radiusKm)
      )
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

    const current = await deliveryRepository.findById(id);
    if (!current) {
      throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');
    }
    if (current.driver_id && String(current.driver_id) !== String(driver._id)) {
      throw this.#alreadyAssigned(current);
    }
    // Only drivers who were offered the order (they were within range) or
    // who are within range now may take it.
    const here = this.#driverCoords(driver);
    const distanceToKitchen = here
      ? haversineKm(here.lat, here.lng, current.pickup_location.latitude, current.pickup_location.longitude)
      : null;
    if (
      !this.#wasOffered(current, String(driver._id)) &&
      !(distanceToKitchen != null && distanceToKitchen <= dispatchRules().radius_km)
    ) {
      throw ApiError.forbidden(
        `This order is more than ${dispatchRules().radius_km} km from you. Only nearby delivery workers can take it.`,
        'DELIVERY_OUT_OF_RANGE'
      );
    }

    const delivery = await deliveryRepository.claim(driver._id, id, {
      status: 'assigned_to_driver',
      assignedAt: now,
    });

    if (!delivery) {
      const latest = await deliveryRepository.findById(id);
      if (latest?.driver_id) throw this.#alreadyAssigned(latest);
      throw ApiError.conflict(
        'This delivery is no longer available.',
        'DELIVERY_NOT_AVAILABLE'
      );
    }

    // Food already waiting: the delay counts from when it was ready — unless
    // this worker is taking over from one who was too late (fresh time).
    const ready = isKitchenReady(delivery);
    let clock = null;
    if (ready) {
      clock = this.#pickupClock(delivery.ready_at ?? delivery.created_at, now, {
        takeover: (delivery.late_history || []).length > 0,
      });
      await deliveryRepository.update(delivery._id, clock);
    }
    await this.#closeOtherOffers(delivery, driver._id, now);

    const fresh = await driverRepository.incrementActive(driver._id);
    const activeCount = fresh?.active_deliveries_count ?? 1;
    if (activeCount >= dispatchRules().max_active_deliveries) {
      await driverRepository.setAvailability(driver._id, { status: 'busy' });
    }

    // While the kitchen is still cooking the order keeps its kitchen status;
    // it shows as "assigned" once the food is ready.
    const orderBefore = await orderRepository.findById(delivery.order_id);
    const order = await orderRepository.update(delivery.order_id, {
      driver_id: driver._id,
      delivery_id: delivery._id,
      rider: { name: driver.name, phone: driver.phone },
      ...(ready ? { status: 'assigned' } : {}),
    });
    await orderRepository.pushHistory(delivery.order_id, {
      status: ready ? 'assigned' : orderBefore?.status || 'placed',
      at: now,
      note: `Delivery worker ${driver.name} assigned`,
    });
    if (order) orderNotifications.deliveryAccepted(order, driver.name);

    const distanceKm = distanceToKitchen != null ? Math.round(distanceToKitchen * 10) / 10 : null;
    return {
      delivery: await this.#serialize(delivery._id, {}, { revealCustomer: true, distanceFromDriverKm: distanceToKitchen ?? undefined }),
      driver: serializeDriverAccount(fresh || driver),
      distance_to_pickup_km: distanceKm,
      message: ready
        ? `The food is ready. Collect it by ${kigaliTime(clock.pickup_due_at)}${
            clock.pickup_reassign_at ? `; at ${kigaliTime(clock.pickup_reassign_at)} it goes to another delivery worker` : ''
          }.`
        : `Head to the kitchen${distanceKm != null ? ` (${distanceKm} km away)` : ''} and wait nearby. Once the food is ready: ${timingText()}`,
    };
  }

  /**
   * Support (admin) hands an order to a chosen delivery worker — after
   * calling them and getting their agreement. Works before anyone accepted
   * and to replace an assigned worker who hasn't collected the food yet
   * (e.g. they were late). The previous worker is released and told why,
   * their late record (if any) is kept with its pending charge, and the
   * vendor and customer are told who is coming instead.
   *
   * `reason`: 'late_pickup' when the previous worker was too slow to collect.
   */
  async adminReassign(order, driver, { reason = null } = {}) {
    let delivery = await deliveryRepository.findByOrderId(order._id);
    if (!delivery) {
      delivery = await this.ensureDeliveryForOrder(order, {
        ready: ['ready', 'assigned'].includes(order.status),
      });
    }
    if (['picked_up', 'out_for_delivery', 'delivered', 'completed'].includes(delivery.status)) {
      throw ApiError.conflict(
        'The delivery worker has already collected this order, so it can no longer be reassigned.',
        'DELIVERY_IN_PROGRESS'
      );
    }
    if (['cancelled', 'rejected'].includes(delivery.status)) {
      throw ApiError.conflict('This delivery was cancelled.', 'DELIVERY_NOT_AVAILABLE');
    }
    const previous = delivery.driver_id ? String(delivery.driver_id) : null;
    if (previous === String(driver._id)) {
      throw ApiError.conflict(`${driver.name} is already delivering this order.`, 'DELIVERY_ALREADY_ASSIGNED');
    }

    const now = new Date();
    const ready = isKitchenReady(delivery);
    // The previous worker was late if their pickup was flagged, or is overdue now.
    const overdue = delivery.pickup_due_at && now > new Date(delivery.pickup_due_at);
    const wasLate = Boolean(previous && (delivery.late_pickup?.flagged_at || overdue));
    const lateReason = reason === 'late_pickup' || wasLate;

    const update = {
      driver_id: driver._id,
      status: 'assigned_to_driver',
      assigned_at: now,
      // A worker support brings in gets their own time from now.
      ...(ready ? this.#pickupClock(delivery.ready_at ?? delivery.created_at, now, { takeover: true }) : NO_CLOCK),
      // A fresh pickup clock for the new worker.
      'late_pickup.warned_at': null,
      'late_pickup.flagged_at': null,
      'late_pickup.minutes_late': null,
      'late_pickup.charge_status': 'none',
      'late_pickup.charge_rwf': null,
      'late_pickup.penalty_percent': null,
    };
    await deliveryRepository.update(delivery._id, update);
    if (wasLate) {
      // The late worker keeps a record of being late (never charged).
      await deliveryRepository.pushLateRecord(delivery._id, {
        driver_id: previous,
        flagged_at: delivery.late_pickup?.flagged_at || now,
        minutes_late: overdue ? Math.ceil((now - new Date(delivery.pickup_due_at)) / 60000) : delivery.late_pickup?.minutes_late ?? null,
        charge_status: LATE_NOT_CHARGED,
        penalty_percent: null,
        note: 'Order reassigned to another delivery worker — no charge',
        reassigned_at: now,
      });
    }
    await deliveryRepository.pushHistory(delivery._id, {
      status: 'assigned_to_driver',
      at: now,
      note: lateReason
        ? `Reassigned to ${driver.name} by support because the previous delivery worker was late to collect`
        : `Assigned to ${driver.name} by support`,
      by: 'admin',
    });
    await this.#closeOtherOffers(delivery, driver._id, now);

    if (previous) {
      await this.#releaseDriver(previous);
      notificationService
        .notifyDriver(previous, {
          type: 'delivery_cancelled',
          title: lateReason ? 'Order reassigned — you were late' : 'Order reassigned',
          body: lateReason
            ? `${delivery.order_number} was assigned to another delivery worker because you didn't collect it on time. Don't go to the kitchen for it.`
            : `Support reassigned ${delivery.order_number} to another delivery worker. You don't need to collect it.`,
          orderId: delivery.order_id,
          data: { delivery_id: String(delivery._id), order_number: delivery.order_number, reason: lateReason ? 'late_pickup' : 'support' },
          sms: true,
        })
        .catch(() => null);
    }

    const fresh = await driverRepository.incrementActive(driver._id);
    if ((fresh?.active_deliveries_count ?? 1) >= dispatchRules().max_active_deliveries) {
      await driverRepository.setAvailability(driver._id, { status: 'busy' });
    }
    notificationService
      .notifyDriver(driver._id, {
        type: 'delivery_update',
        title: 'Order assigned to you',
        body: ready
          ? `Support assigned you ${delivery.order_number}. The food is ready. ${timingText()}`
          : `Support assigned you ${delivery.order_number}. Head to the kitchen; you'll be told when the food is ready.`,
        orderId: delivery.order_id,
        link: '/driver-dashboard/active',
        data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
        sms: true,
      })
      .catch(() => null);

    const updatedOrder = await orderRepository.update(order._id, {
      driver_id: driver._id,
      delivery_id: delivery._id,
      rider: { name: driver.name, phone: driver.phone },
      ...(ready ? { status: 'assigned' } : {}),
    });
    // Kitchen and customer: who is coming now (and why, if it's a replacement).
    if (updatedOrder) {
      orderNotifications.deliveryWorkerChanged(updatedOrder, {
        workerName: driver.name,
        replaced: Boolean(previous),
        late: lateReason,
      });
    }
    return deliveryRepository.findById(delivery._id);
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
    await this.dispatch({ deliveryId: id });

    return { rejected: true, delivery_id: String(id) };
  }

  async updateStatus(driver, deliveryId, body = {}) {
    const id = parseObjectId(deliveryId, 'delivery_id');
    const nextStatus = parseDriverStatus(body?.status);

    const delivery = await deliveryRepository.findByDriverAndId(driver._id, id);
    if (!delivery) {
      throw ApiError.notFound('Delivery not found for this delivery worker.', 'DELIVERY_NOT_FOUND');
    }

    assertTransition(delivery.status, nextStatus);
    if (nextStatus === 'picked_up' && !isKitchenReady(delivery)) {
      throw ApiError.conflict(
        "The kitchen hasn't marked this order ready yet. Wait nearby — you'll be notified the moment it's ready.",
        'ORDER_NOT_READY'
      );
    }

    const now = new Date();
    const update = { status: nextStatus };
    if (nextStatus === 'picked_up') {
      update.picked_up_at = now;
      if (delivery.pickup_due_at && now > new Date(delivery.pickup_due_at)) {
        // Recorded as late for support, never charged.
        update['late_pickup.minutes_late'] = Math.ceil((now - new Date(delivery.pickup_due_at)) / 60000);
        update['late_pickup.charge_status'] = LATE_NOT_CHARGED;
        update['late_pickup.penalty_percent'] = null;
        if (!delivery.late_pickup?.flagged_at) update['late_pickup.flagged_at'] = now;
      }
    }
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
        note: 'Picked up by the delivery worker',
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
      // Link the reminder to the order (not the delivery) so it opens tracking.
      await this.#notifyCustomerDeliveryCode(
        { _id: delivery.order_id, order_number: delivery.order_number, customer_id: delivery.customer_id },
        delivery,
        { reminder: true }
      );
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
      throw ApiError.notFound('Delivery not found for this delivery worker.', 'DELIVERY_NOT_FOUND');
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
    if (delivery.otp_code) {
      // Each try is counted atomically, so the customer's code can't be guessed.
      const maxTries = config.auth.otpMaxAttempts;
      const claimed = await Delivery.findOneAndUpdate(
        { _id: id, otp_attempts: { $lt: maxTries } },
        { $inc: { otp_attempts: 1 } },
        { new: true }
      ).lean();
      if (!claimed) {
        throw ApiError.tooMany(
          'Too many wrong delivery codes for this order. Contact support to complete it.',
          'DELIVERY_CODE_LOCKED'
        );
      }
      if (code !== delivery.otp_code) {
        const left = Math.max(maxTries - claimed.otp_attempts, 0);
        throw new ApiError(
          400,
          'OTP_INVALID',
          left > 0
            ? `Incorrect delivery code. ${left} attempt${left === 1 ? '' : 's'} left.`
            : 'Incorrect delivery code. This delivery is now locked; contact support to complete it.',
          { otp_code: 'incorrect code', attempts_remaining: left }
        );
      }
    }

    const proofPhotoUrl =
      resolveImageUrl({
        file: body?.file,
        image_url: body?.proof_photo_url,
        image_base64: body?.proof_photo_base64,
      }) || undefined;

    const now = new Date();
    // Late pickups are not charged: the worker always gets the full delivery fee.
    const paidEarningsRwf = Number(delivery.promised_earnings_rwf) || 0;
    const wasLate = this.#wasLate(delivery);

    const updated = await deliveryRepository.update(id, {
      status: 'completed',
      completed_at: now,
      otp_verified_at: now,
      paid_earnings_rwf: paidEarningsRwf,
      earnings_penalty_rwf: 0,
      ...(wasLate
        ? {
            'late_pickup.charge_status': LATE_NOT_CHARGED,
            'late_pickup.charge_rwf': null,
            'late_pickup.penalty_percent': null,
            'late_pickup.note': 'Late pickup recorded — late pickups are not charged',
          }
        : {}),
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
      earningsRwf: paidEarningsRwf,
    });

    // The rider keeps the delivery fee; record it on the platform ledger.
    await settlementService
      .recordDriverPayout(
        { _id: delivery.order_id, order_number: delivery.order_number },
        { driverId: driver._id, amountRwf: paidEarningsRwf }
      )
      .catch((error) =>
        console.log(`[delivery] could not record driver payout: ${error?.message}`)
      );

    // Close any late records still marked pending from before late charges were removed.
    await deliveryRepository.waivePendingLateCharges(id, 'Late pickups are not charged');

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
      earned_rwf: paidEarningsRwf,
      penalty_rwf: 0,
      penalty_percent: null,
      driver: serializeDriverAccount(fresh || driver),
    };
  }

  async updateLocation(driver, body = {}) {
    // A worker's position must be in Rwanda (a faked far-away one is refused).
    const coords = parseCoords(body, { field: 'location', required: true, inRwanda: true });
    // Optional GPS extras; anything missing or out of range is dropped.
    const num = (value, min, max) => {
      const n = Number(value);
      return value === null || value === undefined || value === '' || !Number.isFinite(n) || n < min || n > max ? null : n;
    };
    const heading = num(body.heading, 0, 360);
    const speedMps = num(body.speed_mps, 0, 100);
    const accuracyM = num(body.accuracy_m, 0, 100000);
    const updated = await driverRepository.setLocation(driver._id, {
      ...coords,
      heading: heading == null ? null : Math.round(heading),
      speedMps: speedMps == null ? null : Math.round(speedMps * 10) / 10,
      accuracyM: accuracyM == null ? null : Math.round(accuracyM),
    });
    return {
      current_location: {
        latitude: coords.lat,
        longitude: coords.lng,
        heading,
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
      // Food not ready yet: back to "kitchen preparing" for the next driver.
      const status = isKitchenReady(delivery) ? 'ready_for_pickup' : 'pending';
      const now = new Date();
      // A late record belongs to the worker who was late: it moves to the
      // history so the next worker is never charged for someone else's delay.
      if (delivery.late_pickup?.flagged_at) {
        await deliveryRepository.pushLateRecord(delivery._id, {
          driver_id: driverId,
          flagged_at: delivery.late_pickup.flagged_at,
          minutes_late: delivery.late_pickup.minutes_late ?? null,
          charge_status: LATE_NOT_CHARGED,
          penalty_percent: null,
          note: 'Delivery worker went offline — no charge',
          reassigned_at: now,
        });
      }
      await deliveryRepository.update(delivery._id, {
        driver_id: null,
        status,
        assigned_at: null,
        ...NO_CLOCK,
        'late_pickup.warned_at': null,
        'late_pickup.flagged_at': null,
        'late_pickup.minutes_late': null,
        'late_pickup.charge_status': 'none',
        'late_pickup.charge_rwf': null,
        'late_pickup.penalty_percent': null,
      });
      await deliveryRepository.pushHistory(delivery._id, {
        status,
        at: now,
        note: 'Delivery worker went offline — re-broadcast',
        by: 'system',
      });
      await deliveryRepository.addRejection(delivery._id, driverId);
      await this.dispatch({ deliveryId: delivery._id });
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
      const settled = await settlementService.releaseOrder(order._id);
      if (settled) orderNotifications.completed(settled);
    }
  }

  /**
   * The pickup clock, with the warning / charge / reassign times from the
   * admin's current rules. The delay counts from when the food was ready,
   * even if the worker accepted later. Exceptions, so nobody is punished for
   * someone else's delay:
   * - `takeover`: the worker replaces one who was too late (support assigned
   *   them, or the order was re-offered) — their time starts now;
   * - the ready-based "give to another worker" moment has already passed when
   *   they accept — their time starts now too (else it would bounce at once).
   */
  #pickupClock(readyAt, assignedAt, { takeover = false } = {}) {
    const ready = new Date(readyAt).getTime();
    const taken = assignedAt ? new Date(assignedAt).getTime() : ready;
    if (takeover) return deliverySettingsService.pickupClock(new Date(Math.max(ready, taken)));
    const fromReady = deliverySettingsService.pickupClock(new Date(ready));
    if (fromReady.pickup_reassign_at && fromReady.pickup_reassign_at.getTime() <= taken) {
      return deliverySettingsService.pickupClock(new Date(taken));
    }
    return fromReady;
  }

  #locationCutoff() {
    return new Date(Date.now() - dispatchRules().location_max_age_minutes * 60 * 1000);
  }

  #wasOffered(delivery, driverId) {
    return (delivery.dispatch?.offers || []).some((offer) => String(offer.driver_id) === driverId);
  }

  #alreadyAssigned(delivery) {
    return ApiError.conflict(
      `Order ${delivery.order_number} has already been assigned to another delivery worker.`,
      'DELIVERY_ALREADY_ASSIGNED'
    );
  }

  /** The winner is recorded; every other offered driver is told it's taken. */
  async #closeOtherOffers(delivery, winnerId, now) {
    const offers = delivery.dispatch?.offers || [];
    const others = offers.filter(
      (offer) => String(offer.driver_id) !== String(winnerId) && offer.response === 'offered'
    );
    await deliveryRepository.setOffers(delivery._id, {
      offers: offers.map((offer) => ({
        ...offer,
        ...(String(offer.driver_id) === String(winnerId)
          ? { response: 'accepted', responded_at: now }
          : offer.response === 'offered'
            ? { response: 'cancelled', responded_at: now }
            : {}),
      })),
      broadcastCount: delivery.dispatch?.broadcast_count || 0,
      lastBroadcastAt: delivery.dispatch?.last_broadcast_at,
      offerExpiresAt: delivery.dispatch?.offer_expires_at,
    });
    others.forEach((offer) =>
      notificationService
        .notifyDriver(offer.driver_id, {
          type: 'delivery_taken',
          title: 'Order assigned to another delivery worker',
          body: `${delivery.order_number} has been assigned to another delivery worker.`,
          orderId: delivery.order_id,
          data: { delivery_id: String(delivery._id), order_number: delivery.order_number },
        })
        .catch(() => null)
    );
  }

  /** Frees a driver's slot after their delivery is cancelled. */
  async #releaseDriver(driverId) {
    const fresh = await driverRepository.decrementActive(driverId);
    if (!fresh) return;
    if ((fresh.active_deliveries_count ?? 0) < 0) {
      await driverRepository.update(driverId, { active_deliveries_count: 0 });
    }
    if (fresh.is_online && (fresh.active_deliveries_count ?? 0) <= 0) {
      await driverRepository.setAvailability(driverId, { status: 'online' });
    }
  }

  #driverCoords(driver) {
    const coordinates = driver?.location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
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
    // The rider is paid exactly what the customer was charged at checkout.
    const computed = deliveryPricingService.feeForDistance(distanceKm);
    const fee = Number(fallbackFee) > 0 ? Number(fallbackFee) : computed;
    const earnings = deliveryPricingService.driverEarnings(fee);
    return { fee, earnings, computed };
  }

  /** Whether this worker collected the food after the admin's grace period. */
  #wasLate(delivery) {
    const late = delivery.late_pickup || {};
    return (
      Boolean(late.flagged_at) ||
      Number(late.minutes_late) > 0 ||
      late.charge_status === 'pending' ||
      late.charge_status === 'charged'
    );
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
    if (config.explicitDev && delivery.otp_code) {
      serialized.dev_otp = delivery.otp_code;
    }
    return serialized;
  }
}

module.exports = new DeliveryService();

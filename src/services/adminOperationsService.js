const config = require('../config');
const ApiError = require('../utils/ApiError');
const { parseAdminListQuery, parseObjectId } = require('../utils/adminValidators');
const { isKitchenReady } = require('../utils/deliveryReady');
const { Driver, Delivery, Order } = require('../models');
const deliveryRepository = require('../repositories/deliveryRepository');
const vendorRepository = require('../repositories/vendorRepository');
const deliveryTrackingService = require('./deliveryTrackingService');
const deliverySettingsService = require('./deliverySettingsService');

const ONE_HOUR_MS = 60 * 60 * 1000;
const STALE_LOCATION_MS = 2 * 60 * 1000;

const coordsOf = (doc) => {
  const [lng, lat] = doc?.location?.coordinates ?? [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : null;
};

const driverFix = (driver) => {
  const coords = coordsOf(driver);
  if (!coords || !driver.location_updated_at) return null;
  const updatedAt = new Date(driver.location_updated_at);
  return {
    ...coords,
    heading: driver.location_heading ?? null,
    speed_mps: driver.location_speed_mps ?? null,
    accuracy_m: driver.location_accuracy_m ?? null,
    updated_at: updatedAt,
    stale: Date.now() - updatedAt.getTime() > STALE_LOCATION_MS,
  };
};

/**
 * The admin's operational view of dispatch, pickup, live tracking and the
 * rules the platform is running with.
 */
class AdminOperationsService {
  /**
   * Live operations map: every delivery in progress (rider position, kitchen,
   * customer), online delivery workers, and kitchens open right now.
   */
  async liveMap() {
    const activeStatuses = ['pending', 'ready_for_pickup', ...config.delivery.activeStatuses];
    const [deliveries, drivers, kitchens] = await Promise.all([
      Delivery.find({ status: { $in: activeStatuses } })
        .sort({ created_at: -1 })
        .limit(500)
        .populate({ path: 'vendor_id', select: 'name' })
        .lean(),
      Driver.find({ deleted_at: null, is_online: true })
        .select('name phone vehicle_type plate_number status active_deliveries_count location location_updated_at location_heading location_speed_mps location_accuracy_m')
        .limit(1000)
        .lean(),
      vendorRepository
        .findOpenForMap({ coords: null, limit: config.limits.mapVendorsMax })
        .then((result) => result.vendors),
    ]);

    const driversById = new Map(drivers.map((driver) => [String(driver._id), driver]));
    // Assigned workers who went offline mid-delivery still belong on the map.
    const missing = deliveries
      .map((delivery) => delivery.driver_id && String(delivery.driver_id))
      .filter((id) => id && !driversById.has(id));
    if (missing.length) {
      const extra = await Driver.find({ _id: { $in: missing } })
        .select('name phone vehicle_type plate_number status active_deliveries_count location location_updated_at location_heading location_speed_mps location_accuracy_m is_online')
        .lean();
      extra.forEach((driver) => driversById.set(String(driver._id), driver));
    }

    return {
      deliveries: deliveries.map((delivery) => {
        const driver = delivery.driver_id ? driversById.get(String(delivery.driver_id)) : null;
        return {
          id: String(delivery._id),
          order_id: String(delivery.order_id),
          order_number: delivery.order_number,
          status: delivery.status,
          status_label: config.delivery.statusLabels[delivery.status] || delivery.status,
          kitchen_ready: isKitchenReady(delivery),
          pickup_due_at: delivery.pickup_due_at ?? null,
          late: Boolean(delivery.late_pickup?.flagged_at),
          offered_to: (delivery.dispatch?.offers || []).length,
          kitchen: {
            name: delivery.vendor_id?.name || null,
            latitude: delivery.pickup_location?.latitude,
            longitude: delivery.pickup_location?.longitude,
          },
          destination: {
            address: delivery.delivery_location?.address || null,
            latitude: delivery.delivery_location?.latitude,
            longitude: delivery.delivery_location?.longitude,
          },
          driver: driver
            ? { id: String(driver._id), name: driver.name, phone: driver.phone || null, location: driverFix(driver) }
            : null,
        };
      }),
      drivers: [...driversById.values()]
        .filter((driver) => driver.is_online !== false)
        .map((driver) => ({
          id: String(driver._id),
          name: driver.name,
          phone: driver.phone || null,
          vehicle_type: driver.vehicle_type || null,
          plate_number: driver.plate_number || null,
          status: driver.status || 'online',
          active_deliveries: driver.active_deliveries_count || 0,
          location: driverFix(driver),
          // Matching only counts positions newer than this.
          counts_for_dispatch:
            Boolean(driver.location_updated_at) &&
            Date.now() - new Date(driver.location_updated_at).getTime() <= config.delivery.locationMaxAgeMinutes * 60000,
        })),
      kitchens: kitchens.map((vendor) => ({
        id: String(vendor._id),
        name: vendor.name,
        neighborhood: vendor.neighborhood || null,
        ...coordsOf(vendor),
      })),
      generated_at: new Date(),
    };
  }

  /**
   * Late pickups, newest first: the current worker's late record on each
   * delivery and the records of late workers who were replaced by support.
   * Late events are rare, so they are gathered and paged in memory.
   */
  async latePickups(query = {}) {
    const { limit, page, offset } = parseAdminListQuery(query, {
      defaultLimit: config.admin.limits.listDefault,
      maxLimit: config.admin.limits.listMax,
    });
    const deliveries = await Delivery.find({
      $or: [{ 'late_pickup.flagged_at': { $ne: null } }, { 'late_history.0': { $exists: true } }],
    })
      .sort({ updated_at: -1 })
      .limit(1000)
      .populate({ path: 'vendor_id', select: 'name' })
      .lean();

    const driverIds = new Set();
    deliveries.forEach((delivery) => {
      if (delivery.late_pickup?.flagged_at && delivery.driver_id) driverIds.add(String(delivery.driver_id));
      (delivery.late_history || []).forEach((record) => record.driver_id && driverIds.add(String(record.driver_id)));
    });
    const drivers = driverIds.size ? await Driver.find({ _id: { $in: [...driverIds] } }).select('name phone').lean() : [];
    const byId = new Map(drivers.map((driver) => [String(driver._id), driver]));
    const driverOf = (id) => {
      const driver = id && byId.get(String(id));
      return driver ? { id: String(driver._id), name: driver.name, phone: driver.phone || null } : null;
    };

    const rows = [];
    deliveries.forEach((delivery) => {
      const base = {
        id: String(delivery._id),
        order_id: String(delivery.order_id),
        order_number: delivery.order_number,
        status: delivery.status,
        status_label: config.delivery.statusLabels[delivery.status] || delivery.status,
        vendor: delivery.vendor_id ? { name: delivery.vendor_id.name } : null,
        ready_at: delivery.ready_at ?? null,
      };
      (delivery.late_history || []).forEach((record, index) =>
        rows.push({
          ...base,
          key: `${delivery._id}-h${index}`,
          driver: driverOf(record.driver_id),
          flagged_at: record.flagged_at ?? null,
          minutes_late: record.minutes_late ?? null,
          // Taken away and given to another worker by support.
          reassigned_at: record.reassigned_at ?? null,
          still_waiting: false,
          can_reassign: false,
          picked_up_at: null,
          pickup_due_at: null,
          charge_status: record.charge_status || 'pending',
          charge_rwf: record.charge_rwf ?? null,
        })
      );
      if (delivery.late_pickup?.flagged_at) {
        const stillWaiting = !delivery.picked_up_at && delivery.status === 'assigned_to_driver';
        rows.push({
          ...base,
          key: `${delivery._id}-c`,
          driver: driverOf(delivery.driver_id),
          flagged_at: delivery.late_pickup.flagged_at,
          // Still waiting: how late so far; collected: as recorded at pickup.
          minutes_late:
            delivery.late_pickup.minutes_late ??
            (delivery.pickup_due_at
              ? Math.max(0, Math.ceil((Date.now() - new Date(delivery.pickup_due_at).getTime()) / 60000))
              : null),
          reassigned_at: null,
          still_waiting: stillWaiting,
          // Support can hand a still-waiting order to a nearby worker.
          can_reassign: stillWaiting,
          picked_up_at: delivery.picked_up_at ?? null,
          pickup_due_at: delivery.pickup_due_at ?? null,
          charge_status: delivery.late_pickup.charge_status || 'pending',
          charge_rwf: delivery.late_pickup.charge_rwf ?? null,
        });
      }
    });

    rows.sort((a, b) => new Date(b.flagged_at || 0) - new Date(a.flagged_at || 0));
    const pendingCharges = rows.filter((row) => row.charge_status === 'pending').length;
    const waiting = rows.filter((row) => row.still_waiting).length;
    const filtered = ['pending', 'charged', 'waived'].includes(query.charge_status)
      ? rows.filter((row) => row.charge_status === query.charge_status)
      : rows;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      page,
      limit,
      pending_charges: pendingCharges,
      still_waiting: waiting,
    };
  }

  /**
   * Delivery workers near an order's kitchen, nearest first, for support to
   * phone and hand the order to (e.g. when the assigned worker is late).
   * Online workers by default; `include_offline=true` adds offline ones.
   */
  async nearbyDrivers(orderId, query = {}) {
    parseObjectId(orderId, 'order_id');
    const order = await Order.findById(orderId).lean();
    if (!order) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
    if (order.fulfillment === 'pickup') {
      throw ApiError.conflict('The customer collects this order at the kitchen.', 'NOT_A_DELIVERY_ORDER');
    }
    const delivery = await deliveryRepository.findByOrderId(order._id);
    const vendor = await vendorRepository.findById(order.vendor_id);
    const [vLng, vLat] = vendor?.location?.coordinates ?? [];
    const kitchen = {
      name: vendor?.name || null,
      latitude: delivery?.pickup_location?.latitude ?? vLat,
      longitude: delivery?.pickup_location?.longitude ?? vLng,
    };
    if (!Number.isFinite(kitchen.latitude) || !Number.isFinite(kitchen.longitude)) {
      throw ApiError.conflict('The kitchen location is unknown.', 'KITCHEN_LOCATION_MISSING');
    }

    const includeOffline = query.include_offline === 'true';
    const match = { deleted_at: null, is_active: { $ne: false }, verification_status: 'approved' };
    if (!includeOffline) match.is_online = true;
    if (delivery?.driver_id) match._id = { $ne: delivery.driver_id };

    const rows = await Driver.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [kitchen.longitude, kitchen.latitude] },
          distanceField: 'distance_m',
          spherical: true,
          key: 'location',
          query: match,
        },
      },
      { $limit: 40 },
    ]);

    const maxAgeMs = config.delivery.locationMaxAgeMinutes * 60000;
    const current = delivery?.driver_id ? await Driver.findById(delivery.driver_id).select('name phone').lean() : null;
    const drivers = rows.map((driver) => {
      const updatedAt = driver.location_updated_at ? new Date(driver.location_updated_at) : null;
      const max = driver.max_active_deliveries || config.delivery.maxActiveDeliveries;
      return {
        id: String(driver._id),
        name: driver.name,
        phone: driver.phone || null,
        vehicle_type: driver.vehicle_type || null,
        plate_number: driver.plate_number || null,
        rating: driver.rating ?? null,
        is_online: Boolean(driver.is_online),
        active_deliveries: driver.active_deliveries_count || 0,
        has_capacity: (driver.active_deliveries_count || 0) < max,
        // Never-shared positions sit at a default point, so their distance means nothing.
        location_known: Boolean(updatedAt),
        location_updated_at: updatedAt,
        location_fresh: Boolean(updatedAt) && Date.now() - updatedAt.getTime() <= maxAgeMs,
        distance_km: updatedAt ? Math.round((driver.distance_m / 1000) * 10) / 10 : null,
        within_radius: Boolean(updatedAt) && driver.distance_m / 1000 <= config.delivery.defaultRadiusKm,
      };
    });
    // Known positions first (nearest first), then workers who never shared one.
    drivers.sort((a, b) => Number(b.location_known) - Number(a.location_known));

    return {
      order_id: String(order._id),
      order_number: order.order_number,
      kitchen,
      kitchen_ready: isKitchenReady(delivery),
      pickup_due_at: delivery?.pickup_due_at ?? null,
      late: Boolean(
        delivery?.late_pickup?.flagged_at || (delivery?.pickup_due_at && new Date(delivery.pickup_due_at) < new Date())
      ),
      collected: Boolean(delivery && ['picked_up', 'out_for_delivery', 'delivered', 'completed'].includes(delivery.status)),
      current_driver: current ? { id: String(current._id), name: current.name, phone: current.phone || null } : null,
      radius_km: config.delivery.defaultRadiusKm,
      drivers,
    };
  }

  /** Dispatch record for one order's delivery: who was offered it and what happened. */
  async dispatchSummary(delivery) {
    if (!delivery) return null;
    const offers = delivery.dispatch?.offers || [];
    const history = delivery.late_history || [];
    const ids = [
      ...new Set([
        ...offers.map((offer) => String(offer.driver_id)),
        ...(delivery.rejected_by || []).map(String),
        ...history.map((record) => String(record.driver_id)),
      ]),
    ];
    const drivers = ids.length ? await Driver.find({ _id: { $in: ids } }).select('name phone').lean() : [];
    const names = new Map(drivers.map((driver) => [String(driver._id), driver]));
    return {
      broadcasts: delivery.dispatch?.broadcast_count || 0,
      last_broadcast_at: delivery.dispatch?.last_broadcast_at ?? null,
      radius_km: config.delivery.defaultRadiusKm,
      offers: offers.map((offer) => ({
        driver_id: String(offer.driver_id),
        driver_name: names.get(String(offer.driver_id))?.name || 'Delivery worker',
        offered_at: offer.offered_at ?? null,
        responded_at: offer.responded_at ?? null,
        response: offer.response,
      })),
      declined_by: (delivery.rejected_by || []).map((id) => names.get(String(id))?.name || 'Delivery worker'),
      // Workers replaced by support because they were late to collect.
      replaced_late: history.map((record) => ({
        driver_name: names.get(String(record.driver_id))?.name || 'Delivery worker',
        minutes_late: record.minutes_late ?? null,
        reassigned_at: record.reassigned_at ?? null,
        charge_status: record.charge_status || 'pending',
      })),
    };
  }

  /** Live view of one delivery (admin order details map). */
  async deliveryLive(deliveryId) {
    parseObjectId(deliveryId, 'delivery_id');
    const delivery = await deliveryRepository.findById(deliveryId);
    if (!delivery) throw ApiError.notFound('Delivery not found.', 'DELIVERY_NOT_FOUND');
    return deliveryTrackingService.adminView(delivery);
  }

  /** Counts for the overview: what needs attention right now. */
  async attention() {
    const now = Date.now();
    const [awaitingDriver, latePending, waitingPickups, lockedPickups, openKitchens, onlineFresh] = await Promise.all([
      Delivery.countDocuments({ status: { $in: config.delivery.dispatchableStatuses }, driver_id: null }),
      this.#pendingLateCharges(),
      Order.countDocuments({ fulfillment: 'pickup', status: 'ready' }),
      Order.countDocuments({
        fulfillment: 'pickup',
        status: 'ready',
        pickup_code_attempts: { $gte: config.orders.pickupCodeMaxAttempts },
      }),
      vendorRepository.findOpenForMap({ coords: null, limit: 1 }).then((result) => result.total),
      Driver.countDocuments({
        deleted_at: null,
        is_online: true,
        location_updated_at: { $gte: new Date(now - config.delivery.locationMaxAgeMinutes * 60000) },
      }),
    ]);
    const pickupOrdersToday = await Order.countDocuments({
      fulfillment: 'pickup',
      created_at: { $gte: new Date(now - 24 * ONE_HOUR_MS) },
    });
    const lateWaiting = await Delivery.countDocuments({
      'late_pickup.flagged_at': { $ne: null },
      status: 'assigned_to_driver',
    });
    return {
      orders_awaiting_driver: awaitingDriver,
      // Late and still not collected: support should hand these to someone nearby.
      late_pickups_waiting: lateWaiting,
      late_pickups_pending_charge: latePending,
      pickups_awaiting_collection: waitingPickups,
      pickups_locked: lockedPickups,
      pickup_orders_last_24h: pickupOrdersToday,
      kitchens_open: openKitchens,
      drivers_matchable: onlineFresh,
    };
  }

  /** Late-pickup charges still pending, for current and replaced workers. */
  async #pendingLateCharges() {
    const [current, replaced] = await Promise.all([
      Delivery.countDocuments({ 'late_pickup.flagged_at': { $ne: null }, 'late_pickup.charge_status': 'pending' }),
      Delivery.aggregate([
        { $match: { 'late_history.charge_status': 'pending' } },
        { $unwind: '$late_history' },
        { $match: { 'late_history.charge_status': 'pending' } },
        { $count: 'n' },
      ]),
    ]);
    return current + (replaced[0]?.n || 0);
  }

  /** The delivery, pickup, tracking and messaging rules currently in force. */
  rules() {
    const d = config.delivery;
    const maps = config.maps;
    const sms = config.notifications.sms;
    const timing = deliverySettingsService.current();
    return {
      dispatch: {
        radius_km: d.defaultRadiusKm,
        offered_when: 'Immediate orders: the moment they are paid. Scheduled orders and pre-orders: when the kitchen marks them ready.',
        max_drivers_per_broadcast: d.maxOfferRecipients,
        driver_location_max_age_minutes: d.locationMaxAgeMinutes,
        rebroadcast_every_seconds: d.dispatchTickSeconds,
        max_active_deliveries_per_driver: d.maxActiveDeliveries,
      },
      // Set by admins in Settings (see deliverySettingsService).
      pickup_clock: {
        warning_after_minutes: timing.warning_minutes,
        grace_minutes: timing.charge_after_minutes,
        reassign_after_minutes: timing.reassign_after_minutes,
        updated_at: timing.updated_at,
        charge_amount: 'Not set yet — late pickups are recorded with a pending charge.',
      },
      customer_pickup: {
        delivery_fee_rwf: 0,
        code_digits: 6,
        max_wrong_codes: config.orders.pickupCodeMaxAttempts,
      },
      fees: {
        base_rwf: d.baseFeeRwf,
        per_km_rwf: d.perKmFeeRwf,
        minimum_rwf: d.minFeeRwf,
        driver_share_percent: d.driverSharePercent,
      },
      tracking: {
        routes_provider: maps.googleApiKey ? 'Google Routes API' : `OSRM (${maps.osrmUrl})`,
        place_search_provider: maps.googleApiKey ? 'Google Places API' : 'OpenStreetMap (Photon + Nominatim)',
        google_key_configured: Boolean(maps.googleApiKey),
        customer_refresh_seconds: 4,
      },
      sms: {
        configured: Boolean(sms.enabled && sms.apiUrl && sms.apiKey),
        provider: sms.provider,
        note:
          sms.enabled && sms.apiUrl && sms.apiKey
            ? 'Messages are sent by SMS.'
            : 'No SMS gateway: messages only appear in the apps (and the server log).',
      },
    };
  }
}

module.exports = new AdminOperationsService();

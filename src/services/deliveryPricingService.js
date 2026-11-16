const config = require('../config');
const ApiError = require('../utils/ApiError');
const routeDistanceService = require('./routeDistanceService');
const deliveryFeeSettingsService = require('./deliveryFeeSettingsService');
const dispatchSettingsService = require('./dispatchSettingsService');
const { nationwideFor, travelFeeFor } = require('../config/vendorTypes');
const { rangeForDistance } = require('../utils/distanceFeeRanges');

const { MIN_FEE_RWF } = deliveryFeeSettingsService;

const deliveryConfig = config.delivery;

/**
 * Prices the standard platform delivery by the road distance from the kitchen
 * to the drop-off, so a nearby customer is never charged like a far one. In
 * order of precedence (admin Settings -> Delivery fee by distance):
 *
 *  1. per meter (when enabled):
 *       fee = base_fee_rwf + road_meters * per_meter_rwf, between min and max.
 *     Needs a real road distance (Google Routes or OSRM): when no routing
 *     service answers, delivery can't be priced (pickup still can) instead of
 *     charging a straight-line guess.
 *  2. the admin's distance ranges ("0–3 km: 500 RWF, 3–6 km: 1,000 RWF …");
 *  3. the config formula: max(minFeeRwf, baseFeeRwf + perKmFeeRwf * road_km).
 *
 * No fee is ever below 500 RWF. The fee is always computed here, on the
 * server, from the kitchen's saved location and the drop-off point; whatever
 * a client sends as a fee is ignored. It is charged on top of the food
 * subtotal and paid to the rider in full; commission only comes from the food.
 * The worker's GPS trail never changes it (see deliveryService route
 * monitoring, which only flags long detours).
 *
 * Platform delivery workers only go up to the admin's platform delivery range.
 * Beyond it a nationwide kitchen (e.g. a Caterer serving an event in another
 * province) brings the food itself and charges its own travel fee, which it
 * receives in full; other kitchens can't deliver that far (pickup only).
 */
class DeliveryPricingService {
  /** Ranges / formula fee for a distance in km (legacy orders, previews). */
  feeForDistance(distanceKm) {
    const ranged = deliveryFeeSettingsService.feeFor(distanceKm);
    if (ranged !== null) return ranged;
    const { baseFeeRwf, perKmFeeRwf, minFeeRwf } = deliveryConfig;
    const floor = Math.max(MIN_FEE_RWF, minFeeRwf);
    return Math.max(floor, Math.round(baseFeeRwf + perKmFeeRwf * (distanceKm || 0)));
  }

  driverEarnings(feeRwf) {
    return Math.round(feeRwf * (deliveryConfig.driverSharePercent / 100));
  }

  /** Throws when nobody can deliver this far (see `quote`). */
  assertDeliverable(quote) {
    if (!quote.fulfillment) throw ApiError.conflict(quote.unavailable_reason, 'OUT_OF_DELIVERY_RANGE');
    return quote;
  }

  /**
   * What to keep with an order: the approved route and the exact prices used,
   * so later changes to the admin's prices never change an order's fee (and
   * support can always see how it was calculated). Null for non-standard
   * deliveries (pickup, kitchen-delivered).
   */
  pricingRecord(quote) {
    if (!quote || quote.fulfillment !== 'delivery') return null;
    const p = quote.pricing || {};
    return {
      mode: p.mode,
      distance_m: quote.distance_m,
      distance_km: quote.distance_km,
      distance_source: quote.distance_source,
      duration_minutes: quote.duration_minutes ?? null,
      base_fee_rwf: p.base_fee_rwf ?? null,
      per_meter_rwf: p.per_meter_rwf ?? null,
      per_km_fee_rwf: p.per_km_fee_rwf ?? null,
      min_fee_rwf: p.min_fee_rwf ?? null,
      max_fee_rwf: p.max_fee_rwf ?? null,
      range: p.range ?? null,
      formula_fee_rwf: p.formula_fee_rwf ?? null,
      fee_rwf: quote.delivery_fee_rwf,
      pickup: quote.pickup_point,
      dropoff: quote.dropoff_point,
      priced_at: new Date(),
    };
  }

  /**
   * @param {object} vendor vendor document (GeoJSON `location`)
   * @param {{latitude:number, longitude:number}} dropoff
   */
  async quote(vendor, dropoff) {
    const coordinates = vendor?.location?.coordinates;
    const [lng, lat] = Array.isArray(coordinates) ? coordinates : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw ApiError.conflict(
        'This kitchen has no pickup location set, so delivery cannot be priced.',
        'VENDOR_LOCATION_MISSING'
      );
    }
    const pickupPoint = { latitude: lat, longitude: lng };
    const dropoffPoint = { latitude: Number(dropoff.latitude), longitude: Number(dropoff.longitude) };

    const route = await routeDistanceService.measure(pickupPoint, dropoffPoint);
    const maxKm = dispatchSettingsService.current().platform_delivery_max_km;
    const measured = {
      distance_m: route.distance_m,
      distance_km: route.distance_km,
      duration_minutes: route.duration_minutes,
      distance_source: route.source,
      platform_max_km: maxKm,
      pickup: { address: vendor.address || null, neighborhood: vendor.neighborhood || null },
      pickup_point: pickupPoint,
      dropoff_point: dropoffPoint,
    };

    if (route.distance_km > maxKm) {
      const nationwide = nationwideFor(vendor);
      if (nationwide.enabled) {
        return {
          ...measured,
          fulfillment: 'vendor_delivery',
          delivery_fee_rwf: travelFeeFor(vendor, route.distance_km),
          pricing: {
            mode: 'vendor_travel',
            base_fee_rwf: nationwide.travel_base_fee_rwf,
            per_km_rwf: nationwide.travel_per_km_rwf,
          },
        };
      }
      return {
        ...measured,
        fulfillment: null,
        delivery_fee_rwf: null,
        unavailable_reason: `${vendor.name || 'This kitchen'} delivers up to ${maxKm} km away, and this address is about ${Math.round(route.distance_km)} km. Choose pickup, or a kitchen that serves events nationwide.`,
      };
    }

    const { fee, pricing } = this.#standardFee(route);
    return { ...measured, fulfillment: 'delivery', delivery_fee_rwf: fee, pricing };
  }

  /** The standard platform fee for a measured route (see class comment). */
  #standardFee(route) {
    const perMeter = deliveryFeeSettingsService.perMeterFeeFor(route.distance_m);
    if (perMeter) {
      if (!routeDistanceService.isRoadDistance(route)) {
        throw new ApiError(
          503,
          'ROUTE_UNAVAILABLE',
          "We couldn't measure the road distance to this address right now, so the delivery fee can't be calculated. Please try again in a moment, or choose pickup."
        );
      }
      const { settings } = perMeter;
      return {
        fee: perMeter.fee_rwf,
        pricing: {
          mode: 'per_meter',
          base_fee_rwf: settings.base_fee_rwf,
          per_meter_rwf: settings.per_meter_rwf,
          min_fee_rwf: settings.min_fee_rwf,
          max_fee_rwf: settings.max_fee_rwf,
          formula_fee_rwf: perMeter.formula_fee_rwf,
          limited_by: perMeter.limited_by,
        },
      };
    }

    const { ranges } = deliveryFeeSettingsService.current();
    if (ranges.length) {
      const range = rangeForDistance(ranges, route.distance_km);
      return {
        fee: this.feeForDistance(route.distance_km),
        pricing: { mode: 'ranges', ranges, range, min_fee_rwf: MIN_FEE_RWF },
      };
    }

    return {
      fee: this.feeForDistance(route.distance_km),
      pricing: {
        mode: 'formula',
        base_fee_rwf: deliveryConfig.baseFeeRwf,
        per_km_fee_rwf: deliveryConfig.perKmFeeRwf,
        min_fee_rwf: Math.max(MIN_FEE_RWF, deliveryConfig.minFeeRwf),
      },
    };
  }
}

module.exports = new DeliveryPricingService();

const config = require('../config');
const ApiError = require('../utils/ApiError');
const routeDistanceService = require('./routeDistanceService');
const deliveryFeeSettingsService = require('./deliveryFeeSettingsService');
const dispatchSettingsService = require('./dispatchSettingsService');
const { nationwideFor, travelFeeFor } = require('../config/vendorTypes');

const { MIN_FEE_RWF } = deliveryFeeSettingsService;

const deliveryConfig = config.delivery;

/**
 * Prices delivery by the road distance from the kitchen to the drop-off so a
 * nearby customer is never charged like a far one. The admin's distance
 * ranges ("0–3 km: 500 RWF, 3–6 km: 1,000 RWF …") are used when set;
 * otherwise the config formula:
 *
 *   fee = max(minFeeRwf, baseFeeRwf + perKmFeeRwf * road_km)
 *
 * No fee is ever below 500 RWF. The fee is charged on top of the food subtotal
 * and paid to the rider in full; commission only comes from the food subtotal.
 *
 * Platform delivery workers only go up to the admin's platform delivery range.
 * Beyond it a nationwide kitchen (e.g. a Caterer serving an event in another
 * province) brings the food itself and charges its own travel fee, which it
 * receives in full; other kitchens can't deliver that far (pickup only).
 */
class DeliveryPricingService {
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
   * @param {object} vendor vendor document (GeoJSON `location`)
   * @param {{latitude:number, longitude:number}} dropoff
   */
  async quote(vendor, dropoff) {
    const coordinates = vendor?.location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw ApiError.conflict(
        'This kitchen has no pickup location set, so delivery cannot be priced.',
        'VENDOR_LOCATION_MISSING'
      );
    }
    const [lng, lat] = coordinates;

    const route = await routeDistanceService.measure(
      { latitude: lat, longitude: lng },
      { latitude: dropoff.latitude, longitude: dropoff.longitude }
    );
    const maxKm = dispatchSettingsService.current().platform_delivery_max_km;
    const measured = {
      distance_km: route.distance_km,
      duration_minutes: route.duration_minutes,
      distance_source: route.source,
      platform_max_km: maxKm,
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

    const fee = this.feeForDistance(route.distance_km);

    return {
      fulfillment: 'delivery',
      platform_max_km: maxKm,
      distance_km: route.distance_km,
      duration_minutes: route.duration_minutes,
      distance_source: route.source,
      delivery_fee_rwf: fee,
      pricing: deliveryFeeSettingsService.current().ranges.length
        ? { mode: 'ranges', ranges: deliveryFeeSettingsService.current().ranges, min_fee_rwf: MIN_FEE_RWF }
        : {
            mode: 'formula',
            base_fee_rwf: deliveryConfig.baseFeeRwf,
            per_km_fee_rwf: deliveryConfig.perKmFeeRwf,
            min_fee_rwf: Math.max(MIN_FEE_RWF, deliveryConfig.minFeeRwf),
          },
    };
  }
}

module.exports = new DeliveryPricingService();

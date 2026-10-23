const config = require('../config');
const ApiError = require('../utils/ApiError');
const routeDistanceService = require('./routeDistanceService');
const deliveryFeeSettingsService = require('./deliveryFeeSettingsService');

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
    const fee = this.feeForDistance(route.distance_km);

    return {
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

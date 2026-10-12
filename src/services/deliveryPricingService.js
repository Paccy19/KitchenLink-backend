const config = require('../config');
const ApiError = require('../utils/ApiError');
const routeDistanceService = require('./routeDistanceService');

const deliveryConfig = config.delivery;

/**
 * Prices delivery by the road distance from the kitchen to the drop-off so a
 * nearby customer is never charged like a far one:
 *
 *   fee = max(minFeeRwf, baseFeeRwf + perKmFeeRwf * road_km)
 *
 * The fee is charged on top of the food subtotal and paid to the rider in
 * full; platform commission is only ever taken from the food subtotal.
 */
class DeliveryPricingService {
  feeForDistance(distanceKm) {
    const { baseFeeRwf, perKmFeeRwf, minFeeRwf } = deliveryConfig;
    return Math.max(minFeeRwf, Math.round(baseFeeRwf + perKmFeeRwf * (distanceKm || 0)));
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
      pricing: {
        base_fee_rwf: deliveryConfig.baseFeeRwf,
        per_km_fee_rwf: deliveryConfig.perKmFeeRwf,
        min_fee_rwf: deliveryConfig.minFeeRwf,
      },
    };
  }
}

module.exports = new DeliveryPricingService();

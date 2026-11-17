const ApiError = require('../utils/ApiError');
const { Vendor } = require('../models');
const { parseDeliveryCoverage, coverageFor, checkCoverage, COVERAGE_LIMITS } = require('../config/deliveryCoverage');
const { DISTRICTS, publicDistrict } = require('../config/rwandaDistricts');
const bigEventDeliverySettingsService = require('./bigEventDeliverySettingsService');

/**
 * Vendor dashboard → Delivery Coverage: where the kitchen delivers big-event
 * orders. The kitchen sees the platform's pricing (read-only) but can't change it.
 */
class VendorCoverageService {
  get(vendor) {
    const settings = bigEventDeliverySettingsService.settings();
    const [lng, lat] = vendor.location?.coordinates ?? [];
    return {
      coverage: coverageFor(vendor),
      kitchen: { latitude: lat ?? null, longitude: lng ?? null },
      districts: DISTRICTS.map(publicDistrict),
      limits: { areas: COVERAGE_LIMITS.areas, radius_km: COVERAGE_LIMITS.radiusKm },
      // Read-only: set by KitchenLink admins.
      platform_pricing: {
        starting_fee_rwf: settings.starting_fee_rwf,
        per_meter_rwf: settings.per_meter_rwf,
        min_fee_rwf: settings.min_fee_rwf,
        auto_ceiling_rwf: settings.auto_ceiling_rwf,
        automatic_pricing_enabled: settings.enabled,
      },
    };
  }

  async update(vendor, body = {}) {
    // Pricing fields are never the kitchen's to set.
    const forbidden = ['fee_rwf', 'delivery_fee_rwf', 'starting_fee_rwf', 'per_meter_rwf', 'auto_ceiling_rwf', 'min_fee_rwf'].filter(
      (field) => body[field] !== undefined
    );
    if (forbidden.length) {
      throw ApiError.forbidden('Delivery prices are set by KitchenLink. You can only choose where you deliver.', 'PRICING_NOT_EDITABLE');
    }
    const coverage = parseDeliveryCoverage(body);
    const updated = await Vendor.findByIdAndUpdate(
      vendor._id,
      { $set: { delivery_coverage: { ...coverage, updated_at: new Date() } } },
      { returnDocument: 'after', runValidators: true }
    ).lean();
    return this.get(updated);
  }

  /** Is this point inside the kitchen's coverage (decided on the server)? */
  check(vendor, query = {}) {
    const lat = Number(query.lat ?? query.latitude);
    const lng = Number(query.lng ?? query.longitude);
    if (query.lat === '' || query.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw ApiError.badRequest('lat and lng must be valid coordinates.', { lat: 'expected a number', lng: 'expected a number' });
    }
    return checkCoverage(vendor, lat, lng);
  }
}

module.exports = new VendorCoverageService();

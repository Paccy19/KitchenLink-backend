const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const vendorRepository = require('../repositories/vendorRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const deliveryPricingService = require('./deliveryPricingService');
const vendorOrderingService = require('./vendorOrderingService');
const { distanceFromCoords } = require('../utils/geo');
const {
  serializeMenuItem,
  serializeVendorStorefront,
  serializeVendorSpecialCard,
} = require('../utils/serializers');

class VendorService {
  async getStorefront(vendorId, coords) {
    if (!mongoose.isValidObjectId(vendorId)) {
      throw ApiError.badRequest('vendor_id must be a valid id.', {
        vendor_id: 'expected a valid MongoDB id',
      });
    }

    const vendor = await vendorRepository.findActiveById(vendorId);
    if (!vendor) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }

    const items = await menuItemRepository.findByVendor(vendorId);

    const groups = new Map();
    for (const item of items) {
      const category = item.category_id;
      const key = category ? String(category._id) : 'uncategorized';
      if (!groups.has(key)) {
        groups.set(key, { category, items: [] });
      }
      groups.get(key).items.push(item);
    }

    const menu = [...groups.values()]
      .sort((a, b) => {
        const orderA = a.category?.sort_order ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.category?.sort_order ?? Number.MAX_SAFE_INTEGER;
        return (
          orderA - orderB ||
          String(a.category?.name ?? '').localeCompare(String(b.category?.name ?? ''))
        );
      })
      .map((group) => ({
        category: group.category?.name ?? 'Other',
        items: [...group.items]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(serializeMenuItem),
      }));

    const distanceKm = coords
      ? distanceFromCoords(coords, vendor.location?.coordinates)
      : null;

    return {
      ...serializeVendorStorefront(vendor, { menu, distanceKm }),
      // How this kitchen type takes orders (advance-only, notice, limits).
      ordering: await vendorOrderingService.summary(vendor),
    };
  }

  /** Public feed of active "Tomorrow's Special" pre-order announcements. */
  async listSpecials(coords) {
    const vendors = await vendorRepository.findActiveSpecials(30);
    const specials = vendors
      .map((vendor) => {
        const distanceKm = coords
          ? distanceFromCoords(coords, vendor.location?.coordinates)
          : null;
        return serializeVendorSpecialCard({ ...vendor, distance_km: distanceKm });
      })
      .filter((entry) => entry.special && entry.special.is_orderable);
    return { specials };
  }

  /** Distance-based delivery fee from this kitchen to the given point. */
  async getDeliveryQuote(vendorId, coords) {
    if (!mongoose.isValidObjectId(vendorId)) {
      throw ApiError.badRequest('vendor_id must be a valid id.', {
        vendor_id: 'expected a valid MongoDB id',
      });
    }

    const vendor = await vendorRepository.findActiveById(vendorId);
    if (!vendor) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }

    const quote = await deliveryPricingService.quote(vendor, {
      latitude: coords.lat,
      longitude: coords.lng,
    });
    return { vendor_id: String(vendor._id), ...quote };
  }
}

module.exports = new VendorService();

const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const vendorRepository = require('../repositories/vendorRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const menuItemOptionRepository = require('../repositories/menuItemOptionRepository');
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

    // Dishes of a switched-off department are not offered.
    const { Department } = require('../models');
    const inactive = new Set(
      (await Department.find({ vendor_id: vendorId, deleted_at: null, is_active: false }).select('_id').lean()).map((d) => String(d._id))
    );
    const items = (await menuItemRepository.findByVendor(vendorId)).filter(
      (item) => !item.department_id || !inactive.has(String(item.department_id))
    );
    const options = await menuItemOptionRepository.findByMenuItemIds(items.map((item) => item._id));
    const optionsByItem = new Map();
    for (const option of options) {
      if (option.is_available === false) continue;
      const key = String(option.menu_item_id);
      if (!optionsByItem.has(key)) optionsByItem.set(key, []);
      optionsByItem.get(key).push(option);
    }

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
          .map((item) => serializeMenuItem(item, optionsByItem.get(String(item._id)) || [])),
      }));

    const distanceKm = coords
      ? distanceFromCoords(coords, vendor.location?.coordinates)
      : null;

    // The kitchen's services (Food, Coffee, Bakery …): dishes carry department_id.
    const departments = await Department.find({ vendor_id: vendor._id, deleted_at: null, is_active: true }).sort({ sort_order: 1, created_at: 1 }).lean();
    return {
      ...serializeVendorStorefront(vendor, { menu, distanceKm }),
      departments: departments.map(require('./kitchen/departmentService').serializePublic),
      // Photos of the kitchen's own printed menu.
      menu_photos: [...(vendor.menu_photos || [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((p) => ({ id: String(p._id), url: p.url, caption: p.caption || '' })),
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

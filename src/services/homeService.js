const mongoose = require('mongoose');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const vendorRepository = require('../repositories/vendorRepository');
const categoryRepository = require('../repositories/categoryRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const parsePagination = require('../utils/pagination');
const {
  serializeCategory,
  serializeVendorCard,
  serializeNearbyVendor,
  serializePopularDish,
} = require('../utils/serializers');

const assertCategoryId = (categoryId) => {
  if (!mongoose.isValidObjectId(categoryId)) {
    throw ApiError.badRequest('category_id must be a valid id.', {
      category_id: 'expected a valid MongoDB id',
    });
  }
};

class HomeService {
  async getFeed(coords) {
    const locationUsed = Boolean(coords);
    const radiusKm = locationUsed ? config.geo.feedRadiusKm : null;

    const categories = (await categoryRepository.findAll(config.limits.categories)).map(
      serializeCategory
    );

    let vendorRows;
    if (locationUsed) {
      const { vendors } = await vendorRepository.findNearby({
        coords,
        radiusKm,
        sort: 'distance',
        limit: config.limits.feedVendors,
      });
      vendorRows = vendors.map((v) => ({ vendor: v, distanceKm: v.distance_km }));
    } else {
      const vendors = await vendorRepository.findTopRated(config.limits.feedVendors);
      vendorRows = vendors.map((v) => ({ vendor: v, distanceKm: null }));
    }

    const nearbyVendors = vendorRows.map(({ vendor, distanceKm }) =>
      serializeVendorCard(vendor, { distanceKm })
    );

    let dishes = [];
    if (locationUsed) {
      const vendorIds = vendorRows.map(({ vendor }) => vendor._id);
      if (vendorIds.length > 0) {
        dishes = await menuItemRepository.findPopular({
          vendorIds,
          limit: config.limits.feedDishes,
        });
      }
      if (dishes.length === 0) {
        dishes = await menuItemRepository.findPopular({
          limit: config.limits.feedDishes,
        });
      }
    } else {
      dishes = await menuItemRepository.findPopular({
        limit: config.limits.feedDishes,
      });
    }

    return {
      categories,
      nearby_vendors: nearbyVendors,
      popular_dishes: dishes.map(serializePopularDish),
      meta: {
        location_used: locationUsed,
        radius_km: radiusKm,
      },
    };
  }

  async getCategories() {
    const categories = await categoryRepository.findAll(config.limits.categories);
    return { categories: categories.map(serializeCategory) };
  }

  async getNearbyVendors({ coords, radiusKm, categoryId, sort, query }) {
    if (categoryId) {
      assertCategoryId(categoryId);
      const category = await categoryRepository.findById(categoryId);
      if (!category) {
        throw ApiError.notFound('Category not found.', 'CATEGORY_NOT_FOUND');
      }
    }

    const { limit, page, offset } = parsePagination(query, {
      defaultLimit: config.limits.nearbyDefault,
      maxLimit: config.limits.nearbyMax,
    });

    let categoryVendorIds = null;
    if (categoryId) {
      categoryVendorIds = await menuItemRepository.findVendorIdsByCategory(categoryId);
      if (categoryVendorIds.length === 0) {
        return {
          vendors: [],
          meta: {
            limit,
            page,
            offset,
            total: 0,
            radius_km: radiusKm,
            sort,
            category_id: categoryId,
            location_used: true,
          },
        };
      }
    }

    const { vendors, total } = await vendorRepository.findNearby({
      coords,
      radiusKm,
      categoryVendorIds,
      sort,
      limit,
      offset,
    });

    return {
      vendors: vendors.map((v) =>
        serializeNearbyVendor(v, { distanceKm: v.distance_km })
      ),
      meta: {
        limit,
        page,
        offset,
        total,
        radius_km: radiusKm,
        sort,
        category_id: categoryId || null,
        location_used: true,
      },
    };
  }
}

module.exports = new HomeService();

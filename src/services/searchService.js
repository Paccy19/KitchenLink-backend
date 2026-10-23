const config = require('../config');
const vendorRepository = require('../repositories/vendorRepository');
const menuItemRepository = require('../repositories/menuItemRepository');
const { tokenize, buildTokenFilter } = require('../utils/search');
const { distanceFromCoords } = require('../utils/geo');
const { isVendorLive } = require('../utils/vendorPresence');
const { VENDOR_TYPES, vendorTypeLabel } = require('../config/vendorTypes');
const {
  serializeVendorCard,
  serializeSearchDish,
} = require('../utils/serializers');

const lower = (value) => (value || '').toLowerCase();

const tokenScore = (text, token, exactMatchScore, partialMatchScore) => {
  if (!text.includes(token)) return 0;
  return text.startsWith(token) ? exactMatchScore : partialMatchScore;
};

const proximityScore = (distanceKm) =>
  typeof distanceKm === 'number' ? 2 / (1 + distanceKm) : 0;

class SearchService {
  async search({ q, coords, vendorTypes = null }) {
    const tokens = tokenize(q).map((token) => token.toLowerCase());
    const typeAllowed = (code) => !vendorTypes || vendorTypes.includes(code);

    // Searching a type ("bakery", "food truck", "home cook") finds those kitchens too.
    const typedQuery = lower(q);
    const matchedTypes = VENDOR_TYPES.filter(
      (type) =>
        typedQuery.includes(type.label.toLowerCase()) ||
        typedQuery.includes(type.code.replace(/_/g, ' ')) ||
        tokens.some((token) => token.length >= 3 && type.label.toLowerCase().split(/[\s&]+/).includes(token))
    ).map((type) => type.code);

    const dishes = (
      await menuItemRepository.search({
        tokens,
        limit: config.limits.searchCandidateCap,
      })
    ).filter((dish) => typeAllowed(dish.vendor?.vendor_type));
    const dishVendorIds = [...new Set(dishes.map((d) => String(d.vendor_id)))];

    const tokenFilter = buildTokenFilter(tokens, ['name', 'neighborhood']);
    const vendors = await vendorRepository.search({
      tokenFilter: matchedTypes.length ? { $or: [tokenFilter, { vendor_type: { $in: matchedTypes } }] } : tokenFilter,
      dishVendorIds,
      vendorTypes,
      limit: config.limits.searchCandidateCap,
    });

    const scoredDishes = dishes
      .map((dish) => {
        let score = 0;
        const dishName = lower(dish.name);
        const vendorName = lower(dish.vendor?.name);
        const categoryName = lower(dish.category?.name);

        for (const token of tokens) {
          score +=
            tokenScore(dishName, token, 3, 2) ||
            tokenScore(vendorName, token, 1.5, 1.5) ||
            tokenScore(categoryName, token, 1, 1);
        }

        const distanceKm = coords
          ? distanceFromCoords(coords, dish.vendor?.location?.coordinates)
          : null;
        score += proximityScore(distanceKm);

        return {
          dish,
          distanceKm,
          score: Math.round(score * 100) / 100,
        };
      })
      .sort(
        (a, b) => b.score - a.score || (b.dish.orders_count ?? 0) - (a.dish.orders_count ?? 0)
      )
      .slice(0, config.limits.searchMax);

    const scoredVendors = vendors
      .map((vendor) => {
        let score = 0;
        const vendorName = lower(vendor.name);
        const neighborhood = lower(vendor.neighborhood);

        for (const token of tokens) {
          score +=
            tokenScore(vendorName, token, 3, 2) ||
            tokenScore(neighborhood, token, 1, 1);
        }
        if (dishVendorIds.includes(String(vendor._id))) score += 1.5;
        if (matchedTypes.includes(vendor.vendor_type)) score += 2;
        if (isVendorLive(vendor)) score += 1;

        const distanceKm = coords
          ? distanceFromCoords(coords, vendor.location?.coordinates)
          : null;
        score += proximityScore(distanceKm);

        return {
          vendor,
          distanceKm,
          score: Math.round(score * 100) / 100,
        };
      })
      .sort((a, b) => b.score - a.score || b.vendor.rating - a.vendor.rating)
      .slice(0, config.limits.searchMax);

    return {
      query: q.trim(),
      vendors: scoredVendors.map(({ vendor, distanceKm, score }) => ({
        ...serializeVendorCard(vendor, { distanceKm }),
        neighborhood: vendor.neighborhood || null,
        relevance_score: score,
      })),
      dishes: scoredDishes.map(({ dish, distanceKm, score }) => ({
        ...serializeSearchDish(dish, { distanceKm }),
        relevance_score: score,
      })),
      meta: {
        location_used: Boolean(coords),
        limit: config.limits.searchMax,
        vendor_types: vendorTypes,
        matched_vendor_types: matchedTypes.map((code) => ({ code, label: vendorTypeLabel(code) })),
      },
    };
  }
}

module.exports = new SearchService();

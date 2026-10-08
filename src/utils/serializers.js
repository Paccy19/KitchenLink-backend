const round1 = (value) =>
  typeof value === 'number' ? Math.round(value * 10) / 10 : null;

function serializeCategory(category) {
  return {
    id: String(category._id),
    name: category.name,
    icon_url: category.icon_url || null,
  };
}

/** Compact vendor card used in feed / nearby / search lists. */
function serializeVendorCard(vendor, { distanceKm } = {}) {
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    banner_image_url: vendor.banner_image_url || null,
    delivery_available: Boolean(vendor.delivery_available),
  };
}

function serializeNearbyVendor(vendor, { distanceKm } = {}) {
  return {
    ...serializeVendorCard(vendor, { distanceKm }),
    neighborhood: vendor.neighborhood || null,
  };
}

function serializePopularDish(dish) {
  return {
    id: String(dish._id),
    name: dish.name,
    price_rwf: dish.price_rwf,
    image_url: dish.image_url || null,
    vendor_name: dish.vendor?.name ?? null,
    vendor_id: String(dish.vendor_id),
  };
}

function serializeSearchDish(dish, { distanceKm } = {}) {
  return {
    id: String(dish._id),
    name: dish.name,
    description: dish.description || '',
    price_rwf: dish.price_rwf,
    image_url: dish.image_url || null,
    vendor_id: String(dish.vendor_id),
    vendor_name: dish.vendor?.name ?? null,
    category_name: dish.category?.name ?? null,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    relevance_score: 0,
  };
}

function serializeMenuItem(item) {
  return {
    id: String(item._id),
    name: item.name,
    description: item.description || '',
    price_rwf: item.price_rwf,
    is_available: Boolean(item.is_available),
    image_url: item.image_url || null,
  };
}

function serializeVendorStorefront(vendor, { menu, distanceKm } = {}) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    delivery_available: Boolean(vendor.delivery_available),
    location: {
      neighborhood: vendor.neighborhood || null,
      address: vendor.address || null,
      latitude: lat,
      longitude: lng,
    },
    banner_image_url: vendor.banner_image_url || null,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    menu,
  };
}

module.exports = {
  serializeCategory,
  serializeVendorCard,
  serializeNearbyVendor,
  serializePopularDish,
  serializeSearchDish,
  serializeMenuItem,
  serializeVendorStorefront,
};

/**
 * Vendor (kitchen) business types. Stored on every vendor as the `code`;
 * responses also carry the `label`. Menu categories are NOT tied to a type:
 * a Home Cook can sell any kind of food.
 *
 * Keep in sync with frontend/src/data/vendorTypes.js.
 */
const ApiError = require('../utils/ApiError');

const VENDOR_TYPES = [
  { code: 'home_cook', label: 'Home Cook', description: 'Home-made meals cooked in a family kitchen.' },
  { code: 'restaurant', label: 'Restaurant', description: 'A sit-down or takeaway restaurant with a full menu.' },
  { code: 'cafe', label: 'Café', description: 'Coffee, tea, light meals and snacks.' },
  { code: 'bakery', label: 'Bakery', description: 'Bread, cakes, pastries and baked goods.' },
  { code: 'caterer', label: 'Caterer', description: 'Food for events, offices and large groups.' },
  { code: 'food_truck', label: 'Food Truck', description: 'Street food from a mobile kitchen.' },
  { code: 'chef', label: 'Chef', description: 'A professional chef cooking signature dishes.' },
  { code: 'meal_prep', label: 'Meal Prep', description: 'Ready-made meals prepared in advance for the week.' },
  { code: 'juice_drinks', label: 'Juice & Drinks', description: 'Fresh juices, smoothies and other drinks.' },
  // Catch-all for legitimate food businesses that don't fit the types above
  // (kiosks, cultural or diet-specific kitchens, dessert shops, hybrids, niche
  // sellers, pop-up/cloud kitchens). Same features as every type, no extra rules.
  {
    code: 'other',
    label: 'Other',
    title: 'Other food business',
    description: 'Any food business that does not fit the types above (specialty, niche, or unique concept).',
  },
];

/**
 * What each type does well, what it is less suited for, and a short note.
 * These are SOFT guidance only: no type is blocked from any feature or food.
 * `features` are the platform tools that suit the type best (shown as tips
 * on the kitchen dashboard): immediate, scheduled, preorder (Tomorrow's
 * Special), offer_days, pickup, delivery.
 */
const PROFILES = {
  home_cook: {
    strengths: ['Sell any food', 'Scheduled orders & pre-orders', "Tomorrow's Special", 'Small daily capacity', 'Personal touch'],
    less_suited: ['High-volume immediate orders', 'Large catering', 'Formal dine-in feel'],
    note: 'Best for homemade food with limited daily slots.',
    features: ['preorder', 'scheduled', 'pickup'],
  },
  restaurant: {
    strengths: ['Full menu', 'High volume', 'Immediate & scheduled orders', 'Delivery & pick-up'],
    less_suited: ['Very small home-style batches'],
    note: 'Classic full-service kitchen.',
    features: ['immediate', 'scheduled', 'delivery', 'pickup'],
  },
  cafe: {
    strengths: ['Coffee', 'Light meals', 'Breakfast', 'Snacks', 'Quick orders'],
    less_suited: ['Heavy main meals', 'Large catering', 'Late-night heavy food'],
    note: 'Casual and daytime-focused.',
    features: ['immediate', 'pickup'],
  },
  bakery: {
    strengths: ['Bread', 'Cakes', 'Pastries', 'Desserts', 'Pre-orders'],
    less_suited: ['Full savoury meals', 'Hot cooked dishes as the main business'],
    note: 'Can still sell savoury items.',
    features: ['preorder', 'scheduled', 'offer_days'],
  },
  caterer: {
    strengths: ['Bulk orders', 'Events', 'Advance & scheduled orders', 'Large quantities'],
    less_suited: ['Small single-portion immediate orders'],
    note: 'Strong with Offer Days and pre-orders.',
    features: ['offer_days', 'preorder', 'scheduled'],
  },
  food_truck: {
    strengths: ['Mobile location', 'Street-style food', 'Quick service'],
    less_suited: ['Fixed-address fine dining', 'Large advance catering'],
    note: 'Location can change.',
    features: ['immediate', 'pickup'],
  },
  chef: {
    strengths: ['Custom menus', 'Private dining', 'Premium & specialty dishes', 'Scheduled orders'],
    less_suited: ['High-volume standard delivery', 'Cheap daily meals'],
    note: 'More personalised and higher-end.',
    features: ['scheduled', 'preorder', 'offer_days'],
  },
  meal_prep: {
    strengths: ['Weekly plans', 'Portioned meals', 'Subscriptions', 'Scheduled orders'],
    less_suited: ['On-demand single hot meals', 'Café-style snacks'],
    note: 'Best with recurring orders.',
    features: ['scheduled', 'offer_days', 'preorder'],
  },
  juice_drinks: {
    strengths: ['Juices', 'Smoothies', 'Beverages', 'Light add-ons'],
    less_suited: ['Full solid meals as the main offering'],
    note: 'Can still sell light food.',
    features: ['immediate', 'pickup'],
  },
  other: {
    strengths: ["Any specialty or niche concept that doesn't fit the types above"],
    less_suited: [],
    note: 'Catch-all for unique businesses — fully open.',
    features: ['immediate', 'scheduled', 'preorder', 'offer_days'],
  },
};
VENDOR_TYPES.forEach((type) => Object.assign(type, PROFILES[type.code]));

const VENDOR_TYPE_CODES = VENDOR_TYPES.map((type) => type.code);
const BY_CODE = new Map(VENDOR_TYPES.map((type) => [type.code, type]));

// Labels used before types became codes, mapped to their code.
const LEGACY_LABELS = {
  'home cook': 'home_cook',
  restaurant: 'restaurant',
  'café': 'cafe',
  cafe: 'cafe',
  bakery: 'bakery',
  caterer: 'caterer',
  'food truck': 'food_truck',
  chef: 'chef',
  'meal-prep business': 'meal_prep',
  'meal prep': 'meal_prep',
  'juice/drinks vendor': 'juice_drinks',
  'juice & drinks': 'juice_drinks',
  'other food business': 'other',
  other: 'other',
  'bar & grill': 'restaurant',
};

/** A code or an old label → its code, or null when unknown. */
function toVendorTypeCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (BY_CODE.has(raw)) return raw;
  const lower = raw.toLowerCase();
  if (BY_CODE.has(lower)) return lower;
  return LEGACY_LABELS[lower] || null;
}

function vendorTypeLabel(code) {
  return BY_CODE.get(toVendorTypeCode(code))?.label || 'Other';
}

/** Required vendor type on sign-up / admin edits: a code (or an old label). */
function parseVendorType(raw) {
  const code = toVendorTypeCode(raw);
  if (!code) {
    throw ApiError.badRequest('vendor_type is invalid.', {
      vendor_type: `expected one of: ${VENDOR_TYPE_CODES.join(', ')}`,
    });
  }
  return code;
}

/**
 * Optional list filter: `?vendor_type=home_cook`, `?vendor_type=home_cook,cafe`
 * or `?vendor_type=home_cook&vendor_type=cafe`. Returns null when absent.
 */
function parseVendorTypeFilter(query = {}) {
  const raw = query.vendor_type ?? query.vendor_types;
  if (raw === undefined || raw === null || raw === '') return null;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) return null;
  const codes = values.map((value) => {
    const code = toVendorTypeCode(value);
    if (!code) {
      throw ApiError.badRequest(`vendor_type "${value}" is not a vendor type.`, {
        vendor_type: `expected one or more of: ${VENDOR_TYPE_CODES.join(', ')}`,
      });
    }
    return code;
  });
  return [...new Set(codes)];
}

module.exports = {
  VENDOR_TYPES,
  VENDOR_TYPE_CODES,
  toVendorTypeCode,
  vendorTypeLabel,
  parseVendorType,
  parseVendorTypeFilter,
};

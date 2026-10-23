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
  { code: 'other', label: 'Other', description: 'Any other kind of food business.' },
];

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

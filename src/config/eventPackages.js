const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const { parseDistanceFeeRanges, rangeForDistance } = require('../utils/distanceFeeRanges');

/**
 * Big events: each kitchen sets up its own ways of hosting events in its
 * settings — one or more packages (e.g. "Wedding buffet", "Corporate lunch"),
 * each with its own guest ranges and price per plate, what a plate holds and
 * the service — plus one delivery fee by distance for all of them (ranges
 * like the admin's delivery fees). A customer enters the number of guests and
 * chooses delivery or pick-up, and sees every package whose ranges cover that
 * number, with the total cost:
 *
 *   total = guests × the package's plate price (of the range that covers them)
 *         + delivery fee for the distance (delivery only; pick-up pays none)
 */
const SERVICE_STYLES = [
  { code: 'buffet', label: 'Buffet' },
  { code: 'served', label: 'Served at the table' },
  { code: 'drop_off', label: 'Food drop-off only' },
];

const LIMITS = {
  guests: [1, 100000],
  plate_rwf: [100, 1000000],
  delivery_fee_rwf: [0, 1000000],
  delivery_km: 500,
  packages: 10,
  tiers: 10,
  menu_items: 30,
};

// Ordering a big event, like a pre-order: it can be booked weeks or months
// ahead. The customer pays half (deposit_percent) when ordering and the rest
// by balance_due_hours_before the event. The event must be far enough away to
// leave a day to pay the balance (min_lead_hours), and within a year.
const EVENT_ORDER = {
  min_lead_hours: 48,
  max_days_ahead: 365,
  deposit_percent: 50,
  balance_due_hours_before: 24,
};

// Kitchens that saved the single offer from before packages existed: it is
// read as one package with this id and name.
const LEGACY_PACKAGE = { id: 'main', name: 'Event package' };

/** The deposit paid when ordering and the balance due a day before the event. */
function depositPlan(totalRwf, eventAt) {
  const deposit = Math.round((totalRwf * EVENT_ORDER.deposit_percent) / 100);
  return {
    deposit_rwf: deposit,
    balance_rwf: totalRwf - deposit,
    balance_due_at: new Date(new Date(eventAt).getTime() - EVENT_ORDER.balance_due_hours_before * 60 * 60 * 1000),
  };
}

const codes = (list) => list.map((entry) => entry.code);
const labelOf = (list, code) => list.find((entry) => entry.code === code)?.label ?? '';

function wholeNumber(raw, field, [min, max]) {
  const value = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${field} must be a whole number between ${min} and ${max}.`, { [field]: `expected ${min}–${max}` });
  }
  return value;
}

function text(raw, field, max) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw ApiError.badRequest(`${field} must be text.`, { [field]: 'expected text' });
  const value = raw.trim();
  if (value.length > max) throw ApiError.badRequest(`${field} is too long (max ${max} characters).`, { [field]: `max ${max}` });
  return value;
}

function oneOf(raw, field, list) {
  if (!codes(list).includes(raw)) {
    throw ApiError.badRequest(`${field} is not valid.`, { [field]: `expected one of: ${codes(list).join(', ')}` });
  }
  return raw;
}

const PACKAGE_ID = /^[a-z0-9]{4,24}$/;
const isPackageId = (value) => typeof value === 'string' && PACKAGE_ID.test(value);

/** One package from the settings form; `label` names it in error messages. */
function parsePackage(raw = {}, index) {
  const label = typeof raw.name === 'string' && raw.name.trim() ? `"${raw.name.trim()}"` : `Package ${index + 1}`;
  const name = text(raw.name, `packages[${index}].name`, 60);
  if (name.length < 2) {
    throw ApiError.badRequest(`Give package ${index + 1} a name (e.g. "Wedding buffet").`, { [`packages[${index}].name`]: 'required' });
  }

  const rawTiers = Array.isArray(raw.tiers) ? raw.tiers : [];
  if (rawTiers.length > LIMITS.tiers) {
    throw ApiError.badRequest(`${label}: add at most ${LIMITS.tiers} guest ranges.`, { tiers: `max ${LIMITS.tiers}` });
  }
  const tiers = rawTiers
    .map((tier, i) => {
      const min = wholeNumber(tier?.min_guests, `${label}: guests from`, LIMITS.guests);
      const max = wholeNumber(tier?.max_guests, `${label}: guests to`, LIMITS.guests);
      if (max < min) {
        throw ApiError.badRequest(`${label}: in each guest range the most guests must not be fewer than the fewest.`, {
          [`tiers[${i}]`]: 'max_guests must be ≥ min_guests',
        });
      }
      return { min_guests: min, max_guests: max, price_per_plate_rwf: wholeNumber(tier?.price_per_plate_rwf, `${label}: price per plate`, LIMITS.plate_rwf) };
    })
    .sort((a, b) => a.min_guests - b.min_guests);
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].min_guests <= tiers[i - 1].max_guests) {
      throw ApiError.badRequest(`${label}: guest ranges must not overlap.`, { tiers: `${tiers[i - 1].min_guests}–${tiers[i - 1].max_guests} overlaps the next range` });
    }
  }

  const rawMenu = Array.isArray(raw.menu) ? raw.menu : [];
  const menu = rawMenu.map((item, i) => text(item, `${label}: menu item ${i + 1}`, 120)).filter(Boolean);
  if (menu.length > LIMITS.menu_items) {
    throw ApiError.badRequest(`${label}: list at most ${LIMITS.menu_items} menu items.`, { menu: `max ${LIMITS.menu_items}` });
  }

  const enabled = raw.enabled !== false;
  // Customers can only order a package that has a price and a menu; a
  // package that is off may be saved unfinished.
  if (enabled && tiers.length === 0) {
    throw ApiError.badRequest(`${label}: add at least one guest range with a plate price, or turn the package off.`, { tiers: 'required' });
  }
  if (enabled && menu.length === 0) {
    throw ApiError.badRequest(`${label}: list what is on the plate, or turn the package off.`, { menu: 'required' });
  }

  return {
    id: isPackageId(raw.id) ? raw.id : crypto.randomBytes(5).toString('hex'),
    name,
    description: text(raw.description, `${label}: description`, 300),
    enabled,
    tiers,
    menu,
    portion: text(raw.portion, `${label}: quantity per person`, 300),
    service_style: oneOf(raw.service_style ?? 'buffet', `${label}: service`, SERVICE_STYLES),
    service_details: text(raw.service_details, `${label}: service details`, 500),
  };
}

/** Validates the kitchen's big-event settings: its packages and its delivery fee. */
function parseEventPackage(body = {}) {
  const enabled = body.enabled === true;
  const rawPackages = Array.isArray(body.packages) ? body.packages : [];
  if (rawPackages.length > LIMITS.packages) {
    throw ApiError.badRequest(`Add at most ${LIMITS.packages} event packages.`, { packages: `max ${LIMITS.packages}` });
  }
  const packages = rawPackages.map(parsePackage);
  const ids = new Set();
  for (const pkg of packages) {
    // Two packages sent with the same id (e.g. a copy): the copy gets its own.
    if (ids.has(pkg.id)) pkg.id = crypto.randomBytes(5).toString('hex');
    ids.add(pkg.id);
  }

  // Every kitchen delivers when the customer asks; customers may also pick up.
  const [minFee, maxFee] = LIMITS.delivery_fee_rwf;
  const deliveryFeeRanges = parseDistanceFeeRanges(body.delivery_fee_ranges ?? [], { minFee, maxFee, maxKm: LIMITS.delivery_km });

  if (enabled && !packages.some((pkg) => pkg.enabled)) {
    throw ApiError.badRequest('Turn on at least one event package before turning big events on.', { packages: 'required' });
  }
  if (enabled && deliveryFeeRanges.length === 0) {
    throw ApiError.badRequest('Set your delivery fee by distance before turning big events on.', { delivery_fee_ranges: 'required' });
  }
  return {
    enabled,
    packages,
    delivery_fee_ranges: deliveryFeeRanges,
    delivery_details: text(body.delivery_details, 'delivery_details', 500),
  };
}

const normalizePackage = (pkg) => ({
  id: pkg.id,
  name: pkg.name || LEGACY_PACKAGE.name,
  description: pkg.description || '',
  enabled: pkg.enabled !== false,
  tiers: (pkg.tiers || []).map(({ min_guests, max_guests, price_per_plate_rwf }) => ({ min_guests, max_guests, price_per_plate_rwf })),
  menu: pkg.menu || [],
  portion: pkg.portion || '',
  service_style: pkg.service_style || 'buffet',
  service_style_label: labelOf(SERVICE_STYLES, pkg.service_style || 'buffet'),
  service_details: pkg.service_details || '',
});

/** The kitchen's stored big-event settings with defaults filled in. */
function eventPackageFor(vendor) {
  const own = vendor?.event_package || {};
  const packages = own.packages?.length
    ? own.packages
    : own.tiers?.length || own.menu?.length
      ? [{ ...own, ...LEGACY_PACKAGE, enabled: true }]
      : [];
  return {
    enabled: Boolean(own.enabled),
    packages: packages.map(normalizePackage),
    delivery_fee_ranges: (own.delivery_fee_ranges || []).map(({ from_km, to_km, fee_rwf }) => ({ from_km, to_km: to_km ?? null, fee_rwf })),
    delivery_details: own.delivery_details || '',
  };
}

/** Packages customers can order: big events on, the package on, priced and with a menu. */
const orderablePackages = (offer) =>
  offer.enabled ? offer.packages.filter((pkg) => pkg.enabled && pkg.tiers.length && pkg.menu.length) : [];

const tierFor = (pkg, guests) => pkg.tiers.find((t) => guests >= t.min_guests && guests <= t.max_guests);

/**
 * A package's cost for `guests` people, or null when no range covers that
 * number: `pickup_total_rwf` when the customer picks the food up, `total_rwf`
 * when the kitchen delivers. The delivery fee needs the distance from the
 * kitchen to the customer (`distanceKm`); without it `delivery_fee_rwf` is
 * null and `total_rwf` is the food only.
 */
function eventQuoteFor(offer, pkg, guests, distanceKm = null) {
  const tier = tierFor(pkg, guests);
  if (!tier) return null;
  const food = guests * tier.price_per_plate_rwf;
  const deliveryRange = typeof distanceKm === 'number' ? rangeForDistance(offer.delivery_fee_ranges, distanceKm) : null;
  const delivery = deliveryRange ? deliveryRange.fee_rwf : null;
  return {
    guests,
    price_per_plate_rwf: tier.price_per_plate_rwf,
    tier: { min_guests: tier.min_guests, max_guests: tier.max_guests },
    food_total_rwf: food,
    distance_km: typeof distanceKm === 'number' ? Math.round(distanceKm * 10) / 10 : null,
    delivery_fee_rwf: delivery,
    delivery_range: deliveryRange,
    total_rwf: food + (delivery ?? 0),
    pickup_total_rwf: food,
  };
}

/**
 * What customers see of a kitchen in the Big Event list: its orderable
 * packages (with `guests`, only those covering that number, each with its
 * quote, cheapest first), plus the shared delivery fee. Null when none.
 */
function serializeEventOffer(vendor, guests = null, distanceKm = null) {
  const offer = eventPackageFor(vendor);
  const packages = orderablePackages(offer)
    .map((pkg) => {
      const prices = pkg.tiers.map((t) => t.price_per_plate_rwf);
      return {
        ...pkg,
        min_guests: pkg.tiers[0].min_guests,
        max_guests: pkg.tiers[pkg.tiers.length - 1].max_guests,
        from_price_per_plate_rwf: Math.min(...prices),
        quote: guests ? eventQuoteFor(offer, pkg, guests, distanceKm) : null,
      };
    })
    .filter((pkg) => !guests || pkg.quote)
    .sort((a, b) => (a.quote?.food_total_rwf ?? a.from_price_per_plate_rwf) - (b.quote?.food_total_rwf ?? b.from_price_per_plate_rwf));
  if (!packages.length) return null;
  return {
    packages,
    delivery_fee_ranges: offer.delivery_fee_ranges,
    delivery_details: offer.delivery_details,
    min_guests: Math.min(...packages.map((pkg) => pkg.min_guests)),
    max_guests: Math.max(...packages.map((pkg) => pkg.max_guests)),
    from_price_per_plate_rwf: Math.min(...packages.map((pkg) => pkg.from_price_per_plate_rwf)),
  };
}

/**
 * A big-event order's price, worked out on the server from the package the
 * customer chose: guests × the plate price of their range, plus (delivery
 * only) the kitchen's fee for the road distance. Without a distance yet, a
 * delivery price has `delivery_fee_rwf` null and the food as its total.
 * `package` is the package priced. Throws when the package can't be ordered
 * or no guest range covers `guests`.
 */
function priceEventOrder(offer, guests, { packageId = null, pickup, distanceKm = null }) {
  const orderable = orderablePackages(offer);
  if (!orderable.length) {
    throw new ApiError(409, 'EVENTS_UNAVAILABLE', "This kitchen isn't taking big-event orders right now.");
  }
  // Without a choice, a kitchen with a single package means that one.
  const pkg = packageId ? orderable.find((p) => p.id === packageId) : orderable.length === 1 ? orderable[0] : null;
  if (!pkg) {
    throw ApiError.badRequest(
      packageId ? 'That event package is no longer available. Choose another one.' : 'Choose one of the kitchen’s event packages.',
      { package_id: 'expected one of the kitchen’s packages' }
    );
  }
  const tier = tierFor(pkg, guests);
  if (!tier) {
    const min = pkg.tiers[0].min_guests;
    const max = pkg.tiers[pkg.tiers.length - 1].max_guests;
    throw new ApiError(409, 'GUESTS_OUT_OF_RANGE', `"${pkg.name}" is for ${min}–${max} guests, not ${guests}.`);
  }
  const food = guests * tier.price_per_plate_rwf;
  const range = pickup || distanceKm == null ? null : rangeForDistance(offer.delivery_fee_ranges, distanceKm);
  const deliveryFee = pickup ? 0 : range ? range.fee_rwf : null;
  return {
    package: pkg,
    guests,
    price_per_plate_rwf: tier.price_per_plate_rwf,
    tier: { min_guests: tier.min_guests, max_guests: tier.max_guests },
    food_total_rwf: food,
    delivery_fee_rwf: deliveryFee,
    delivery_range: range,
    total_rwf: food + (deliveryFee ?? 0),
  };
}

/** The customer's choices for a big-event order (the price is the server's). */
function parseEventOrder(body = {}) {
  const guests = wholeNumber(body.guests, 'guests', LIMITS.guests);
  if (!['delivery', 'pickup'].includes(body.fulfillment)) {
    throw ApiError.badRequest('Choose delivery or pick-up.', { fulfillment: 'expected delivery or pickup' });
  }
  const packageId = isPackageId(body.package_id) ? body.package_id : null;
  return { guests, pickup: body.fulfillment === 'pickup', packageId };
}

/**
 * Mongo filter: kitchens with big events on and an orderable package
 * (covering `guests` when given). Kitchens still on the old single offer
 * (no packages saved yet) match on its top-level guest ranges.
 */
function eventsMongoFilter(guests = null) {
  const covers = guests ? { $elemMatch: { min_guests: { $lte: guests }, max_guests: { $gte: guests } } } : { $exists: true, $ne: [] };
  return {
    'event_package.enabled': true,
    $or: [
      { 'event_package.packages': { $elemMatch: { enabled: true, 'menu.0': { $exists: true }, tiers: covers } } },
      { 'event_package.packages.0': { $exists: false }, 'event_package.menu.0': { $exists: true }, 'event_package.tiers': covers },
    ],
  };
}

/** Optional `?guests=` on the customer lists (null when absent). */
function parseGuestsFilter(query = {}) {
  if (query.guests === undefined || query.guests === '') return null;
  return wholeNumber(query.guests, 'guests', LIMITS.guests);
}

module.exports = {
  EVENT_ORDER,
  depositPlan,
  priceEventOrder,
  parseEventOrder,
  SERVICE_STYLES,
  LIMITS,
  parseEventPackage,
  eventPackageFor,
  serializeEventOffer,
  eventsMongoFilter,
  parseGuestsFilter,
};

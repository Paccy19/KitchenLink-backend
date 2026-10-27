const ApiError = require('../utils/ApiError');
const { parseDistanceFeeRanges, rangeForDistance } = require('../utils/distanceFeeRanges');

/**
 * Big events: each kitchen sets its own event offer in its settings — guest
 * ranges with a price per plate, what a plate holds, the service it gives and
 * its delivery fee by distance (ranges like the admin's delivery fees). A
 * customer enters the number of guests and chooses delivery or pick-up, and
 * sees every kitchen whose ranges cover that number, with the total cost:
 *
 *   total = guests × plate price (of the range that covers them)
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
  tiers: 10,
  menu_items: 30,
};

// Ordering a big event: the kitchen needs time to shop and cook for many
// guests, so the event must be at least a day away (and within a year).
const EVENT_ORDER = { min_lead_hours: 24, max_days_ahead: 365 };

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

/** Validates the kitchen's event offer from its settings form. */
function parseEventPackage(body = {}) {
  const enabled = body.enabled === true;
  const rawTiers = Array.isArray(body.tiers) ? body.tiers : [];
  if (rawTiers.length > LIMITS.tiers) {
    throw ApiError.badRequest(`Add at most ${LIMITS.tiers} guest ranges.`, { tiers: `max ${LIMITS.tiers}` });
  }
  const tiers = rawTiers
    .map((tier, index) => {
      const min = wholeNumber(tier?.min_guests, `tiers[${index}].min_guests`, LIMITS.guests);
      const max = wholeNumber(tier?.max_guests, `tiers[${index}].max_guests`, LIMITS.guests);
      if (max < min) {
        throw ApiError.badRequest('In each guest range the most guests must not be fewer than the fewest.', {
          [`tiers[${index}]`]: 'max_guests must be ≥ min_guests',
        });
      }
      return { min_guests: min, max_guests: max, price_per_plate_rwf: wholeNumber(tier?.price_per_plate_rwf, `tiers[${index}].price_per_plate_rwf`, LIMITS.plate_rwf) };
    })
    .sort((a, b) => a.min_guests - b.min_guests);
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].min_guests <= tiers[i - 1].max_guests) {
      throw ApiError.badRequest('Guest ranges must not overlap.', { tiers: `${tiers[i - 1].min_guests}–${tiers[i - 1].max_guests} overlaps the next range` });
    }
  }

  const rawMenu = Array.isArray(body.menu) ? body.menu : [];
  const menu = rawMenu.map((item, index) => text(item, `menu[${index}]`, 120)).filter(Boolean);
  if (menu.length > LIMITS.menu_items) {
    throw ApiError.badRequest(`List at most ${LIMITS.menu_items} menu items.`, { menu: `max ${LIMITS.menu_items}` });
  }

  // Every kitchen delivers when the customer asks; customers may also pick up.
  const [minFee, maxFee] = LIMITS.delivery_fee_rwf;
  const deliveryFeeRanges = parseDistanceFeeRanges(body.delivery_fee_ranges ?? [], { minFee, maxFee, maxKm: LIMITS.delivery_km });
  const offer = {
    enabled,
    tiers,
    menu,
    portion: text(body.portion, 'portion', 300),
    service_style: oneOf(body.service_style ?? 'buffet', 'service_style', SERVICE_STYLES),
    service_details: text(body.service_details, 'service_details', 500),
    delivery_fee_ranges: deliveryFeeRanges,
    delivery_details: text(body.delivery_details, 'delivery_details', 500),
  };

  // Customers can only find an offer that has a price and a menu.
  if (enabled && tiers.length === 0) {
    throw ApiError.badRequest('Add at least one guest range with a plate price before turning big events on.', { tiers: 'required' });
  }
  if (enabled && deliveryFeeRanges.length === 0) {
    throw ApiError.badRequest('Set your delivery fee by distance before turning big events on.', { delivery_fee_ranges: 'required' });
  }
  if (enabled && menu.length === 0) {
    throw ApiError.badRequest('List what is on the plate before turning big events on.', { menu: 'required' });
  }
  return offer;
}

/** The kitchen's stored offer with defaults filled in. */
function eventPackageFor(vendor) {
  const own = vendor?.event_package || {};
  return {
    enabled: Boolean(own.enabled),
    tiers: (own.tiers || []).map(({ min_guests, max_guests, price_per_plate_rwf }) => ({ min_guests, max_guests, price_per_plate_rwf })),
    menu: own.menu || [],
    portion: own.portion || '',
    service_style: own.service_style || 'buffet',
    service_style_label: labelOf(SERVICE_STYLES, own.service_style || 'buffet'),
    service_details: own.service_details || '',
    delivery_fee_ranges: (own.delivery_fee_ranges || []).map(({ from_km, to_km, fee_rwf }) => ({ from_km, to_km: to_km ?? null, fee_rwf })),
    delivery_details: own.delivery_details || '',
  };
}

/**
 * The cost for `guests` people, or null when no range covers that number:
 * `pickup_total_rwf` when the customer picks the food up, `total_rwf` when
 * the kitchen delivers. The delivery fee needs the distance from the kitchen
 * to the customer (`distanceKm`); without it `delivery_fee_rwf` is null and
 * `total_rwf` is the food only.
 */
function eventQuoteFor(offer, guests, distanceKm = null) {
  const tier = offer.tiers.find((t) => guests >= t.min_guests && guests <= t.max_guests);
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

/** What customers see of a kitchen's offer in the Big Event list. */
function serializeEventOffer(vendor, guests = null, distanceKm = null) {
  const offer = eventPackageFor(vendor);
  if (!offer.enabled) return null;
  const prices = offer.tiers.map((t) => t.price_per_plate_rwf);
  return {
    ...offer,
    min_guests: offer.tiers[0]?.min_guests ?? null,
    max_guests: offer.tiers[offer.tiers.length - 1]?.max_guests ?? null,
    from_price_per_plate_rwf: prices.length ? Math.min(...prices) : null,
    quote: guests ? eventQuoteFor(offer, guests, distanceKm) : null,
  };
}

/**
 * A big-event order's price, worked out on the server from the kitchen's
 * offer: guests × the plate price of their range, plus (delivery only) the
 * kitchen's fee for the road distance. Without a distance yet, a delivery
 * price has `delivery_fee_rwf` null and the food as its total. Throws when
 * the offer is off or no guest range covers `guests`.
 */
function priceEventOrder(offer, guests, { pickup, distanceKm = null }) {
  if (!offer.enabled) {
    throw new ApiError(409, 'EVENTS_UNAVAILABLE', "This kitchen isn't taking big-event orders right now.");
  }
  const tier = offer.tiers.find((t) => guests >= t.min_guests && guests <= t.max_guests);
  if (!tier) {
    const min = offer.tiers[0]?.min_guests;
    const max = offer.tiers[offer.tiers.length - 1]?.max_guests;
    throw new ApiError(409, 'GUESTS_OUT_OF_RANGE', `This kitchen hosts events for ${min}–${max} guests, not ${guests}.`);
  }
  const food = guests * tier.price_per_plate_rwf;
  const range = pickup || distanceKm == null ? null : rangeForDistance(offer.delivery_fee_ranges, distanceKm);
  const deliveryFee = pickup ? 0 : range ? range.fee_rwf : null;
  return {
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
  return { guests, pickup: body.fulfillment === 'pickup' };
}

/** Mongo filter: kitchens with big events on, covering `guests` when given. */
function eventsMongoFilter(guests = null) {
  const filter = { 'event_package.enabled': true };
  if (guests) {
    filter['event_package.tiers'] = { $elemMatch: { min_guests: { $lte: guests }, max_guests: { $gte: guests } } };
  }
  return filter;
}

/** Optional `?guests=` on the customer lists (null when absent). */
function parseGuestsFilter(query = {}) {
  if (query.guests === undefined || query.guests === '') return null;
  return wholeNumber(query.guests, 'guests', LIMITS.guests);
}

module.exports = {
  EVENT_ORDER,
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

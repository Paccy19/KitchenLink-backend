const ApiError = require('../utils/ApiError');
const { haversineKm } = require('../utils/geo');
const routeDistanceService = require('./routeDistanceService');
const bigEventDeliverySettingsService = require('./bigEventDeliverySettingsService');
const { checkCoverage, coverageFor } = require('../config/deliveryCoverage');
const { TRIGGER_MESSAGES, CUSTOMER_MESSAGE } = require('../config/specialDelivery');

// Road routes outside these bounds are treated as routing errors, never billed.
const MAX_ROAD_KM = 1500;
const MIN_ROAD_TO_STRAIGHT = 0.9; // a road can't be much shorter than a straight line
const MAX_ROAD_TO_STRAIGHT = 6; // nor many times longer (plus a few km for short trips)

function kitchenPoint(vendor) {
  const [lng, lat] = vendor?.location?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.conflict('This kitchen has no location set, so delivery cannot be priced.', 'VENDOR_LOCATION_MISSING');
  }
  return { latitude: lat, longitude: lng };
}

/** A route we are willing to bill: from a routing service, and plausible for the two points. */
function isReasonableRoute(route, from, to) {
  if (!routeDistanceService.isRoadDistance(route)) return false;
  const roadKm = Number(route.distance_m) / 1000;
  if (!Number.isFinite(roadKm) || roadKm < 0 || roadKm > MAX_ROAD_KM) return false;
  const straightKm = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
  if (straightKm > 0.2 && roadKm < straightKm * MIN_ROAD_TO_STRAIGHT) return false;
  if (roadKm > straightKm * MAX_ROAD_TO_STRAIGHT + 5) return false;
  return true;
}

/**
 * Big-event delivery price for a kitchen and a destination, decided on the
 * server from the platform's settings, the road distance and the kitchen's
 * coverage. The result's `status`:
 *
 *  - 'automatic'            fee_rwf is the platform's price (≤ the ceiling, in coverage)
 *  - 'negotiation_required' no automatic price: the customer may request a
 *                           special delivery (`reasons` says why)
 *  - 'unavailable'          the kitchen doesn't deliver big events (pick-up only)
 */
async function priceFor(vendor, destination) {
  const coverage = coverageFor(vendor);
  const settings = bigEventDeliverySettingsService.settings();
  const base = {
    ceiling_rwf: settings.auto_ceiling_rwf,
    starting_fee_rwf: settings.starting_fee_rwf,
    per_meter_rwf: settings.per_meter_rwf,
  };
  if (!coverage.big_event_enabled) {
    return {
      ...base,
      status: 'unavailable',
      reasons: ['kitchen_does_not_deliver'],
      message: "This kitchen doesn't deliver big-event orders. You can pick the food up at the kitchen.",
      fee_rwf: null,
      calculated_fee_rwf: null,
      can_request_special_delivery: false,
    };
  }

  const from = kitchenPoint(vendor);
  const to = { latitude: destination.latitude, longitude: destination.longitude };
  const inCoverage = checkCoverage(vendor, to.latitude, to.longitude);
  const measured = await routeDistanceService.measure(from, to);
  const route = isReasonableRoute(measured, from, to) ? measured : null;

  const reasons = [];
  if (!inCoverage.covered) reasons.push('outside_coverage');
  let fee = null;
  if (!route) {
    reasons.push('route_unavailable');
  } else {
    fee = bigEventDeliverySettingsService.feeFor(route.distance_m);
    if (!settings.enabled) reasons.push('automatic_pricing_off');
    else if (fee.requires_negotiation) reasons.push('above_ceiling');
  }

  const automatic = reasons.length === 0;
  return {
    ...base,
    status: automatic ? 'automatic' : 'negotiation_required',
    reasons,
    reason_messages: reasons.map((reason) => TRIGGER_MESSAGES[reason]).filter(Boolean),
    message: automatic ? null : CUSTOMER_MESSAGE,
    can_request_special_delivery: !automatic,
    fee_rwf: automatic ? fee.fee_rwf : null,
    calculated_fee_rwf: fee ? fee.calculated_fee_rwf : null,
    formula_fee_rwf: fee ? fee.formula_fee_rwf : null,
    min_fee_rwf: settings.min_fee_rwf,
    distance_m: route ? Math.round(route.distance_m) : null,
    distance_km: route ? Math.round(route.distance_m / 100) / 10 : null,
    distance_source: route?.source ?? null,
    duration_minutes: route?.duration_minutes ?? null,
    in_coverage: inCoverage.covered,
    destination_district: inCoverage.district,
    matched_area: inCoverage.matched_area,
    pickup: from,
    dropoff: to,
  };
}

/** What the order keeps of an automatic price (Order.big_event_delivery). */
function automaticRecord(price) {
  return {
    mode: 'automatic',
    fee_rwf: price.fee_rwf,
    distance_m: price.distance_m,
    distance_source: price.distance_source,
    starting_fee_rwf: price.starting_fee_rwf,
    per_meter_rwf: price.per_meter_rwf,
    min_fee_rwf: price.min_fee_rwf,
    auto_ceiling_rwf: price.ceiling_rwf,
    formula_fee_rwf: price.formula_fee_rwf,
    in_coverage: price.in_coverage,
    destination_district: price.destination_district?.code ?? null,
    pickup: price.pickup,
    dropoff: price.dropoff,
    priced_at: new Date(),
  };
}

module.exports = { priceFor, automaticRecord, isReasonableRoute };

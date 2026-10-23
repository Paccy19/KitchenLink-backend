const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords, parseRequiredCoords } = require('../utils/geo');
const placeSearchService = require('../services/placeSearchService');
const routeNavigationService = require('../services/routeNavigationService');

/** GET /geo/places/autocomplete?q&lat&lng — suggestions while typing an area or street. */
const autocomplete = asyncHandler(async (req, res) => {
  res.json(
    await placeSearchService.autocomplete({ q: req.query.q, near: parseOptionalCoords(req.query) })
  );
});

/** GET /geo/places/details?id — the picked place: position, map box and area outline. */
const details = asyncHandler(async (req, res) => {
  res.json({ place: await placeSearchService.details(req.query.id) });
});

/** GET /geo/places/reverse?lat&lng — the area and street at a point. */
const reverse = asyncHandler(async (req, res) => {
  res.json(await placeSearchService.reverse(parseRequiredCoords(req.query)));
});

/**
 * GET /geo/route?from_lat&from_lng&to_lat&to_lng — the road route between two
 * points (e.g. a customer walking or driving to collect their order): distance,
 * time, the line to draw on the map and step-by-step directions.
 */
const route = asyncHandler(async (req, res) => {
  const from = parseRequiredCoords({ lat: req.query.from_lat, lng: req.query.from_lng });
  const to = parseRequiredCoords({ lat: req.query.to_lat, lng: req.query.to_lng });
  const result = await routeNavigationService.route(from, to);
  res.json({
    source: result.source,
    distance_m: result.distance_m,
    duration_s: result.duration_s,
    geometry: result.geometry,
    steps: (result.steps || []).slice(0, 60),
  });
});

module.exports = { autocomplete, details, reverse, route };

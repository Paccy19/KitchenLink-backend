const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords, parseRequiredCoords } = require('../utils/geo');
const placeSearchService = require('../services/placeSearchService');

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

module.exports = { autocomplete, details, reverse };

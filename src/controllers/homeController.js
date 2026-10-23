const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords, parseRequiredCoords, parseRadius } = require('../utils/geo');
const homeService = require('../services/homeService');
const searchService = require('../services/searchService');
const { parseVendorTypeFilter } = require('../config/vendorTypes');

const feed = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(await homeService.getFeed(coords, { vendorTypes: parseVendorTypeFilter(req.query) }));
});

const categories = asyncHandler(async (req, res) => {
  res.json(await homeService.getCategories());
});

const nearbyVendors = asyncHandler(async (req, res) => {
  const coords = parseRequiredCoords(req.query);
  const radiusKm = parseRadius(req.query);
  const sort = req.query.sort === 'rating' ? 'rating' : 'distance';

  res.json(
    await homeService.getNearbyVendors({
      coords,
      radiusKm,
      categoryId: req.query.category_id,
      vendorTypes: parseVendorTypeFilter(req.query),
      sort,
      query: req.query,
    })
  );
});

const mapVendors = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(
    await homeService.getMapVendors({
      coords,
      categoryId: req.query.category_id,
      vendorTypes: parseVendorTypeFilter(req.query),
    })
  );
});

const allVendors = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  const sort = req.query.sort === 'rating' ? 'rating' : 'distance';
  res.json(
    await homeService.getAllVendors({
      coords,
      categoryId: req.query.category_id,
      vendorTypes: parseVendorTypeFilter(req.query),
      sort,
      query: req.query,
    })
  );
});

const search = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(await searchService.search({ q: req.query.q, coords, vendorTypes: parseVendorTypeFilter(req.query) }));
});

module.exports = { feed, categories, nearbyVendors, mapVendors, allVendors, search };

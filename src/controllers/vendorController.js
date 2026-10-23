const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords, parseRequiredCoords } = require('../utils/geo');
const vendorService = require('../services/vendorService');
const homeService = require('../services/homeService');
const { VENDOR_TYPES, parseVendorTypeFilter } = require('../config/vendorTypes');

/** GET /vendors/types — every vendor type with its label and description. */
const getTypes = asyncHandler(async (req, res) => {
  res.json({ vendor_types: VENDOR_TYPES });
});

/**
 * GET /vendors — every active kitchen (nearby first when coordinates are
 * given). Filters: ?vendor_type=home_cook,cafe and ?category_id=….
 */
const listVendors = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(
    await homeService.getAllVendors({
      coords,
      categoryId: req.query.category_id,
      vendorTypes: parseVendorTypeFilter(req.query),
      sort: req.query.sort === 'rating' ? 'rating' : 'distance',
      query: req.query,
    })
  );
});

const getVendor = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(
    await vendorService.getStorefront(req.params.vendor_id, coords)
  );
});

const getSpecials = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(await vendorService.listSpecials(coords));
});

const getDeliveryQuote = asyncHandler(async (req, res) => {
  const coords = parseRequiredCoords(req.query);
  res.json(await vendorService.getDeliveryQuote(req.params.vendor_id, coords));
});

module.exports = { getTypes, listVendors, getVendor, getSpecials, getDeliveryQuote };

const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords, parseRequiredCoords } = require('../utils/geo');
const vendorService = require('../services/vendorService');

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

module.exports = { getVendor, getSpecials, getDeliveryQuote };

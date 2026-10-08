const asyncHandler = require('../utils/asyncHandler');
const { parseOptionalCoords } = require('../utils/geo');
const vendorService = require('../services/vendorService');

const getVendor = asyncHandler(async (req, res) => {
  const coords = parseOptionalCoords(req.query);
  res.json(
    await vendorService.getStorefront(req.params.vendor_id, coords)
  );
});

module.exports = { getVendor };

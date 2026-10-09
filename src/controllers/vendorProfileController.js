const asyncHandler = require('../utils/asyncHandler');
const vendorProfileService = require('../services/vendorProfileService');

const update = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.update(req.vendor, req.body, req.file));
});

module.exports = { update };

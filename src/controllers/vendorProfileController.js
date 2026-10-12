const asyncHandler = require('../utils/asyncHandler');
const vendorProfileService = require('../services/vendorProfileService');

const update = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.update(req.vendor, req.body, req.files));
});

const setAvailability = asyncHandler(async (req, res) => {
  res.json(await vendorProfileService.setAvailability(req.vendor, req.body));
});

module.exports = { update, setAvailability };

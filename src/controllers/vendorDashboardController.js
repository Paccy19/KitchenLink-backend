const asyncHandler = require('../utils/asyncHandler');
const vendorDashboardService = require('../services/vendorDashboardService');

const overview = asyncHandler(async (req, res) => {
  res.json(await vendorDashboardService.overview(req.vendor));
});

module.exports = { overview };

const asyncHandler = require('../utils/asyncHandler');
const adminDashboardService = require('../services/adminDashboardService');

const overview = asyncHandler(async (req, res) => {
  res.json(await adminDashboardService.overview());
});

module.exports = { overview };

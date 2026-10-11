const asyncHandler = require('../utils/asyncHandler');
const adminAnalyticsService = require('../services/adminAnalyticsService');

const overview = asyncHandler(async (req, res) => {
  res.json(await adminAnalyticsService.overview(req.query));
});

const sales = asyncHandler(async (req, res) => {
  res.json(await adminAnalyticsService.sales(req.query));
});

const payouts = asyncHandler(async (req, res) => {
  res.json(await adminAnalyticsService.payouts(req.query));
});

module.exports = { overview, sales, payouts };

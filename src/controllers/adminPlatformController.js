const asyncHandler = require('../utils/asyncHandler');
const adminPlatformService = require('../services/adminPlatformService');

const wallet = asyncHandler(async (req, res) => {
  res.json(await adminPlatformService.wallet(req.query));
});

const transactions = asyncHandler(async (req, res) => {
  res.json(await adminPlatformService.transactions(req.query));
});

module.exports = { wallet, transactions };

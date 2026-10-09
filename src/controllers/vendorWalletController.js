const asyncHandler = require('../utils/asyncHandler');
const vendorWalletService = require('../services/vendorWalletService');

const getWallet = asyncHandler(async (req, res) => {
  res.json(await vendorWalletService.getWallet(req.vendor));
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  res
    .status(201)
    .json(await vendorWalletService.requestWithdrawal(req.vendor, req.body));
});

module.exports = { getWallet, requestWithdrawal };

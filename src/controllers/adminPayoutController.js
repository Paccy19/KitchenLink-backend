const asyncHandler = require('../utils/asyncHandler');
const adminPayoutService = require('../services/adminPayoutService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminPayoutService.listWithdrawals(req.query));
});

const update = asyncHandler(async (req, res) => {
  res.json(
    await adminPayoutService.updateWithdrawal(
      req.params.withdrawalId,
      {
        status: req.body?.status,
        reference: req.body?.reference,
        reason: req.body?.reason,
        action_code: req.body?.action_code,
      },
      req.admin,
      req
    )
  );
});

const balances = asyncHandler(async (req, res) => {
  res.json(await adminPayoutService.vendorBalances(req.query));
});

const summary = asyncHandler(async (req, res) => {
  res.json(await adminPayoutService.summary(req.query));
});

module.exports = { list, update, balances, summary };

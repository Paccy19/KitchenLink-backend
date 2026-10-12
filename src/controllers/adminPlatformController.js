const asyncHandler = require('../utils/asyncHandler');
const adminPlatformService = require('../services/adminPlatformService');
const platformOwnerService = require('../services/platformOwnerService');

const wallet = asyncHandler(async (req, res) => {
  res.json(await adminPlatformService.wallet(req.query));
});

const transactions = asyncHandler(async (req, res) => {
  res.json(await adminPlatformService.transactions(req.query));
});

/* ------------------------- owner (super admin) ------------------------- */

const ownerOverview = asyncHandler(async (req, res) => {
  res.json(await platformOwnerService.overview(req.admin));
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  res.status(201).json(await platformOwnerService.requestWithdrawal(req.admin, req.body, req));
});

const completeWithdrawal = asyncHandler(async (req, res) => {
  res.json(await platformOwnerService.completeWithdrawal(req.admin, req.params.withdrawalId, req.body, req));
});

const cancelWithdrawal = asyncHandler(async (req, res) => {
  res.json(await platformOwnerService.cancelWithdrawal(req.admin, req.params.withdrawalId, req.body, req));
});

const addDestination = asyncHandler(async (req, res) => {
  res.status(201).json(await platformOwnerService.addDestination(req.admin, req.body, req));
});

const removeDestination = asyncHandler(async (req, res) => {
  res.json(await platformOwnerService.removeDestination(req.admin, req.params.destinationId, req.body, req));
});

const recordAdjustment = asyncHandler(async (req, res) => {
  res.status(201).json(await platformOwnerService.recordAdjustment(req.admin, req.body, req));
});

const savePayoutSettings = asyncHandler(async (req, res) => {
  res.json(await platformOwnerService.savePayoutSettings(req.admin, req.body, req));
});

const recordReconciliation = asyncHandler(async (req, res) => {
  res.status(201).json(await platformOwnerService.recordReconciliation(req.admin, req.body, req));
});

module.exports = {
  wallet,
  transactions,
  ownerOverview,
  requestWithdrawal,
  completeWithdrawal,
  cancelWithdrawal,
  addDestination,
  removeDestination,
  recordAdjustment,
  savePayoutSettings,
  recordReconciliation,
};

const asyncHandler = require('../utils/asyncHandler');
const adminPaymentService = require('../services/adminPaymentService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminPaymentService.list(req.query));
});

const summary = asyncHandler(async (req, res) => {
  res.json(await adminPaymentService.summary(req.query));
});

module.exports = { list, summary };

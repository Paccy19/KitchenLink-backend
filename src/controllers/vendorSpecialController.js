const asyncHandler = require('../utils/asyncHandler');
const vendorSpecialService = require('../services/vendorSpecialService');

const get = asyncHandler(async (req, res) => {
  res.json(vendorSpecialService.get(req.vendor));
});

const upsert = asyncHandler(async (req, res) => {
  res.json(await vendorSpecialService.upsert(req.vendor, req.body));
});

const clear = asyncHandler(async (req, res) => {
  res.json(await vendorSpecialService.clear(req.vendor));
});

module.exports = { get, upsert, clear };

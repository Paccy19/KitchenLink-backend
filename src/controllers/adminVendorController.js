const asyncHandler = require('../utils/asyncHandler');
const adminVendorService = require('../services/adminVendorService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminVendorService.list(req.query));
});

const getById = asyncHandler(async (req, res) => {
  res.json(await adminVendorService.getById(req.params.vendorId));
});

const setStatus = asyncHandler(async (req, res) => {
  res.json(
    await adminVendorService.setStatus(
      req.params.vendorId,
      { status: req.body?.status, reason: req.body?.reason },
      req.admin,
      req
    )
  );
});

const counts = asyncHandler(async (req, res) => {
  res.json(await adminVendorService.counts());
});

module.exports = { list, getById, setStatus, counts };

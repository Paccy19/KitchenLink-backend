const asyncHandler = require('../utils/asyncHandler');
const adminDriverService = require('../services/adminDriverService');

const list = asyncHandler(async (req, res) => {
  res.json(await adminDriverService.list(req.query));
});

const getById = asyncHandler(async (req, res) => {
  res.json(await adminDriverService.getById(req.params.driverId));
});

const setStatus = asyncHandler(async (req, res) => {
  res.json(
    await adminDriverService.setStatus(
      req.params.driverId,
      { status: req.body?.status, reason: req.body?.reason },
      req.admin,
      req
    )
  );
});

const liveDeliveries = asyncHandler(async (req, res) => {
  res.json(await adminDriverService.liveDeliveries(req.query));
});

const counts = asyncHandler(async (req, res) => {
  res.json(await adminDriverService.counts());
});

module.exports = { list, getById, setStatus, liveDeliveries, counts };

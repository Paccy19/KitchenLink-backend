const asyncHandler = require('../utils/asyncHandler');
const vendorOrderService = require('../services/vendorOrderService');

const list = asyncHandler(async (req, res) => {
  res.json(await vendorOrderService.list(req.vendor, req.query));
});

const getDetail = asyncHandler(async (req, res) => {
  res.json(await vendorOrderService.getDetail(req.vendor, req.params.order_id));
});

const updateStatus = asyncHandler(async (req, res) => {
  res.json(
    await vendorOrderService.updateStatus(
      req.vendor,
      req.params.order_id,
      req.body
    )
  );
});

module.exports = { list, getDetail, updateStatus };

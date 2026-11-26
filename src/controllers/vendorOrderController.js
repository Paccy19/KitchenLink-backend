const asyncHandler = require('../utils/asyncHandler');
const vendorOrderService = require('../services/vendorOrderService');

const list = asyncHandler(async (req, res) => {
  res.json(await vendorOrderService.list(req.vendor, req.query, req.kitchenAccess));
});

const getDetail = asyncHandler(async (req, res) => {
  res.json(await vendorOrderService.getDetail(req.vendor, req.params.order_id, req.kitchenAccess));
});

const updateStatus = asyncHandler(async (req, res) => {
  res.json(
    await vendorOrderService.updateStatus(
      req.vendor,
      req.params.order_id,
      req.body,
      req.kitchenAccess
    )
  );
});

/** POST /vendor/orders/:order_id/collect { pickup_code } — pickup orders only. */
const confirmPickup = asyncHandler(async (req, res) => {
  res.json(await vendorOrderService.confirmPickup(req.vendor, req.params.order_id, req.body, req.kitchenAccess));
});

module.exports = { list, getDetail, updateStatus, confirmPickup };

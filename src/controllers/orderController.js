const asyncHandler = require('../utils/asyncHandler');
const orderService = require('../services/orderService');

const paymentMethods = asyncHandler(async (req, res) => {
  res.json(await orderService.paymentMethods());
});

const checkout = asyncHandler(async (req, res) => {
  res.json(await orderService.checkout(req.customer._id, req.body));
});

const listOrders = asyncHandler(async (req, res) => {
  res.json(await orderService.list(req.customer._id, req.query));
});

const getOrder = asyncHandler(async (req, res) => {
  res.json(await orderService.getDetail(req.customer._id, req.params.order_id));
});

const trackOrder = asyncHandler(async (req, res) => {
  res.json(await orderService.track(req.customer._id, req.params.order_id));
});

const cancelOrder = asyncHandler(async (req, res) => {
  res.json(await orderService.cancel(req.customer._id, req.params.order_id, req.body));
});

const payOrder = asyncHandler(async (req, res) => {
  res.json(await orderService.pay(req.customer._id, req.params.order_id, req.body));
});

module.exports = {
  paymentMethods,
  checkout,
  listOrders,
  getOrder,
  trackOrder,
  cancelOrder,
  payOrder,
};

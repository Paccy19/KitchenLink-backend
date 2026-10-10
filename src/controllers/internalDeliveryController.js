const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const orderRepository = require('../repositories/orderRepository');
const deliveryService = require('../services/deliveryService');

/** Triggered when a vendor marks an order as ready for pickup. */
const ready = asyncHandler(async (req, res) => {
  const order = await orderRepository.findById(req.params.order_id);
  if (!order) {
    throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
  }
  const result = await deliveryService.handleOrderReady(order);
  res.status(201).json(result);
});

/** Manual/forced matching & broadcast pass (also re-dispatches stale offers). */
const dispatch = asyncHandler(async (req, res) => {
  const { order_id, delivery_id, force } = req.body || {};

  if (order_id || delivery_id) {
    res.json(
      await deliveryService.dispatch({
        orderId: order_id,
        deliveryId: delivery_id,
        force: Boolean(force),
      })
    );
    return;
  }

  res.json(await deliveryService.expireStaleOffers());
});

module.exports = { ready, dispatch };

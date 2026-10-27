const { Router } = require('express');
const ApiError = require('../utils/ApiError');
const isAgentKey = require('../utils/agentKey');
const asyncHandler = require('../utils/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const orderController = require('../controllers/orderController');
const orderService = require('../services/orderService');
const deliveryTrackingService = require('../services/deliveryTrackingService');

const router = Router();

router.get('/payment-methods', orderController.paymentMethods);
router.post('/checkout', requireAuth, orderController.checkout);
// Big events: the price for a kitchen's event offer, then the order itself.
router.post('/event-quote', orderController.eventQuote);
router.post('/event-checkout', requireAuth, orderController.eventCheckout);
router.get('/', requireAuth, orderController.listOrders);
router.get(
  '/refunds',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await orderService.listRefunds(req.customer._id));
  })
);
router.get('/:order_id', requireAuth, orderController.getOrder);
router.get('/:order_id/track', requireAuth, orderController.trackOrder);
// Live map: the delivery worker's position, route and ETA (polled every few seconds).
router.get(
  '/:order_id/live',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await deliveryTrackingService.customerLive(req.customer._id, req.params.order_id));
  })
);
router.post('/:order_id/cancel', requireAuth, orderController.cancelOrder);
router.post('/:order_id/pay', requireAuth, orderController.payOrder);
// Big events: pay the second half (due a day before the event).
router.post('/:order_id/pay-balance', requireAuth, orderController.payBalance);
router.post('/:order_id/switch-to-delivery/quote', requireAuth, orderController.quoteSwitchToDelivery);
router.post('/:order_id/switch-to-delivery', requireAuth, orderController.switchToDelivery);
// Where the refund of a cancelled paid order is sent (mobile money number).
router.put(
  '/:order_id/refund-destination',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await orderService.changeRefundDestination(req.customer._id, req.params.order_id, req.body));
  })
);

// Agent (vendor/rider)
router.patch(
  '/agent/orders/:order_id/status',
  asyncHandler(async (req, res) => {
    if (!isAgentKey(req.headers['x-agent-key'])) {
      throw ApiError.unauthorized(
        'Valid x-agent-key header is required.',
        'AGENT_UNAUTHORIZED'
      );
    }
    res.json(await orderService.updateStatus(req.params.order_id, req.body));
  })
);

module.exports = router;

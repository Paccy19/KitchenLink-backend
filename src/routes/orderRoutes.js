const { Router } = require('express');
const ApiError = require('../utils/ApiError');
const config = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const orderController = require('../controllers/orderController');
const orderService = require('../services/orderService');

const router = Router();

router.get('/payment-methods', orderController.paymentMethods);
router.post('/checkout', requireAuth, orderController.checkout);
router.get('/', requireAuth, orderController.listOrders);
router.get('/:order_id', requireAuth, orderController.getOrder);
router.get('/:order_id/track', requireAuth, orderController.trackOrder);
router.post('/:order_id/cancel', requireAuth, orderController.cancelOrder);
router.post('/:order_id/pay', requireAuth, orderController.payOrder);

// Agent (vendor/rider)
router.patch(
  '/agent/orders/:order_id/status',
  asyncHandler(async (req, res) => {
    const key = req.headers['x-agent-key'];
    if (key !== config.orders.agentKey) {
      throw ApiError.unauthorized(
        'Valid x-agent-key header is required.',
        'AGENT_UNAUTHORIZED'
      );
    }
    res.json(await orderService.updateStatus(req.params.order_id, req.body));
  })
);

module.exports = router;

const { Router } = require('express');
const ApiError = require('../utils/ApiError');
const config = require('../config');
const internalDeliveryController = require('../controllers/internalDeliveryController');

const router = Router();

/** Internal/system endpoints are guarded by the shared agent key. */
router.use((req, res, next) => {
  const key = req.headers['x-agent-key'];
  if (key !== config.orders.agentKey) {
    next(
      ApiError.unauthorized(
        'Valid x-agent-key header is required.',
        'AGENT_UNAUTHORIZED'
      )
    );
    return;
  }
  next();
});

router.post('/:order_id/ready', internalDeliveryController.ready);
router.post('/dispatch', internalDeliveryController.dispatch);

module.exports = router;
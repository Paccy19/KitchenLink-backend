const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const vendorOrderController = require('../controllers/vendorOrderController');

const router = Router();

router.use(requireVendorAuth);

router.get('/', vendorOrderController.list);
router.get('/:order_id', vendorOrderController.getDetail);
router.patch('/:order_id/status', vendorOrderController.updateStatus);

module.exports = router;

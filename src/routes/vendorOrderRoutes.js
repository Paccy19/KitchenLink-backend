const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const requireApprovedVendor = require('../middleware/requireApprovedVendor');
const vendorOrderController = require('../controllers/vendorOrderController');
const can = require('../middleware/requireKitchenPermission');

const router = Router();

router.use(requireVendorAuth);

router.get('/', can('orders.view'), vendorOrderController.list);
router.get('/:order_id', can('orders.view'), vendorOrderController.getDetail);
router.patch('/:order_id/status', requireApprovedVendor, vendorOrderController.updateStatus);
// The customer collected a pickup order: the vendor enters their pickup code.
router.post('/:order_id/collect', requireApprovedVendor, vendorOrderController.confirmPickup);

module.exports = router;

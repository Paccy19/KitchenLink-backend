const { Router } = require('express');
const requireVendorAuth = require('../middleware/requireVendorAuth');
const vendorNotificationController = require('../controllers/vendorNotificationController');

const router = Router();

router.use(requireVendorAuth);

router.get('/', vendorNotificationController.list);
router.post('/read-all', vendorNotificationController.markAllRead);
router.post('/:notification_id/read', vendorNotificationController.markRead);

module.exports = router;

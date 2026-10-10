const { Router } = require('express');
const requireAuth = require('../middleware/requireAuth');
const notificationController = require('../controllers/notificationController');

const router = Router();

router.get('/', requireAuth, notificationController.listNotifications);
router.post('/read-all', requireAuth, notificationController.markAllNotificationsRead);
router.post('/:notification_id/read', requireAuth, notificationController.markNotificationRead);

module.exports = router;

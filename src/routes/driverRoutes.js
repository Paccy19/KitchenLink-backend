const { Router } = require('express');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const driverController = require('../controllers/driverController');
const upload = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');
const deliveryTrackingService = require('../services/deliveryTrackingService');

const router = Router();

// Everything below requires a driver bearer token.
router.use(requireDriverAuth);

router.patch('/profile', upload.single('profile_image'), driverController.updateProfile);

router.get('/notifications', driverController.listNotifications);
router.post('/notifications/read-all', driverController.markAllNotificationsRead);
router.post('/notifications/:notification_id/read', driverController.markNotificationRead);

router.get('/deliveries/available', driverController.available);
router.get('/deliveries/active', driverController.active);
router.get('/deliveries/history', driverController.history);
router.get('/deliveries/earnings', driverController.earnings);
router.get('/stats', driverController.stats);

router.post('/deliveries/:delivery_id/accept', driverController.accept);
router.post('/deliveries/:delivery_id/reject', driverController.reject);
router.patch('/deliveries/:delivery_id/status', driverController.updateStatus);
router.post('/deliveries/:delivery_id/confirm-delivery', driverController.confirmDelivery);
// GPS navigation: route + turn-by-turn steps to the kitchen, then the customer.
router.get(
  '/deliveries/:delivery_id/navigation',
  asyncHandler(async (req, res) => {
    res.json(await deliveryTrackingService.driverNavigation(req.driver, req.params.delivery_id));
  })
);

router.patch('/location', driverController.updateLocation);
router.patch('/availability', driverController.setAvailability);

// Wallet: balance from completed deliveries, withdrawals to mobile money.
router.get('/wallet', driverController.getWallet);
router.post('/wallet/withdrawals', driverController.requestWithdrawal);

module.exports = router;
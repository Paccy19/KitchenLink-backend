const { Router } = require('express');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const driverController = require('../controllers/driverController');
const upload = require('../middleware/upload');

const router = Router();

// Everything below requires a driver bearer token.
router.use(requireDriverAuth);

router.patch('/profile', upload.single('profile_image'), driverController.updateProfile);

router.get('/deliveries/available', driverController.available);
router.get('/deliveries/active', driverController.active);
router.get('/deliveries/history', driverController.history);
router.get('/deliveries/earnings', driverController.earnings);
router.get('/stats', driverController.stats);

router.post('/deliveries/:delivery_id/accept', driverController.accept);
router.post('/deliveries/:delivery_id/reject', driverController.reject);
router.patch('/deliveries/:delivery_id/status', driverController.updateStatus);
router.post('/deliveries/:delivery_id/confirm-delivery', driverController.confirmDelivery);

router.patch('/location', driverController.updateLocation);
router.patch('/availability', driverController.setAvailability);

module.exports = router;
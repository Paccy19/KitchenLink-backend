const { Router } = require('express');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const driverAuthController = require('../controllers/driverAuthController');

const router = Router();

router.post('/register', driverAuthController.register);
router.post('/send-otp', driverAuthController.sendOtp);
router.post('/verify-otp', driverAuthController.verifyOtp);
router.get('/me', requireDriverAuth, driverAuthController.me);
router.post('/change-password', requireDriverAuth, driverAuthController.changePassword);

module.exports = router;